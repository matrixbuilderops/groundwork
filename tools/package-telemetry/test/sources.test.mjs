import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMetrics,
  getPepyStats,
  getPyPIStats,
  renderTable
} from '../src/telemetry.mjs';

const TODAY = new Date().toISOString().slice(0, 10);

const pepyOk = {
  id: 'pkg',
  total_downloads: 100,
  versions: ['1.0', '1.1'],
  downloads: {
    '2026-01-01': { '1.0': 5, '1.1': 7 },
    '2026-01-02': { '1.1': 20 },
    [TODAY]: { '1.1': 3 }
  }
};

const pypiMeta = { info: { version: '1.1', summary: '' }, releases: {} };

const stubFetcher = (routes) => async (url) => {
  for (const [prefix, body] of routes) {
    if (url.startsWith(prefix)) return body;
  }
  return { _error: `unstubbed: ${url}` };
};

describe('getPepyStats', () => {
  it('parses totals + daily version-sums from the pepy payload', async () => {
    const r = await getPepyStats('pkg', stubFetcher([
      ['https://pepy.tech/api/v2/projects/pkg', pepyOk]
    ]));
    assert.equal(r.lifetime, 100);
    assert.equal(r.perMonth, 35);
    assert.equal(r.lastDay, 20);
    assert.equal(r.lastDayDate, '2026-01-02');
    assert.equal(r.today, 3);
  });

  it('returns null on error or bad shape', async () => {
    assert.equal(await getPepyStats('pkg', stubFetcher([])), null);
    assert.equal(await getPepyStats('pkg', stubFetcher([
      ['https://pepy.tech/', { id: 'pkg' }]
    ])), null);
  });
});

describe('pip source chain', () => {
  const statsOk = { data: [
    { date: TODAY, category: 'without_mirrors', downloads: 11 },
    { date: TODAY, category: 'with_mirrors', downloads: 110 }
  ] };

  it('records pypistats as source on the happy path', async () => {
    const r = await getPyPIStats('pkg', null, '', stubFetcher([
      ['https://pypi.org/pypi/pkg/json', pypiMeta],
      ['https://pypistats.org/api/packages/pkg/overall', statsOk]
    ]));
    assert.equal(r.downloads_source, 'pypistats');
    assert.equal(r.downloads_lifetime, 110);
    assert.equal(r.downloads_lifetime_real, 11);
    assert.equal(r.headlines_real_only, false);
    assert.equal(r.downloads_stale, false);
  });

  it('falls back to pepy when pypistats is down', async () => {
    const r = await getPyPIStats('pkg', null, '', stubFetcher([
      ['https://pypi.org/pypi/pkg/json', pypiMeta],
      ['https://pepy.tech/api/v2/projects/pkg', pepyOk]
    ]));
    assert.equal(r.downloads_source, 'pepy-fallback');
    assert.equal(r.downloads_lifetime, 100);
    assert.equal(r.downloads_per_month, 35);
    assert.equal(r.downloads_stale, false);
  });

  it('falls through to cache when both sources fail', async () => {
    const cached = {
      downloads_lifetime: 50, downloads_per_month: 5, downloads_last_day: 1, downloads_current_day: 0,
      downloads_lifetime_with_mirrors: 400, downloads_per_month_with_mirrors: 40,
      downloads_last_day_with_mirrors: 8, downloads_current_day_with_mirrors: 2
    };
    const r = await getPyPIStats('pkg', cached, '', stubFetcher([
      ['https://pypi.org/pypi/pkg/json', pypiMeta]
    ]));
    assert.equal(r.downloads_source, 'cache');
    assert.equal(r.downloads_lifetime, 400);
    assert.equal(r.downloads_lifetime_real, 50);
    assert.equal(r.downloads_stale, true);
  });

  it('realOnly skips pepy and resolves cache to the real series', async () => {
    const cached = {
      downloads_lifetime: 50, downloads_per_month: 5, downloads_last_day: 1, downloads_current_day: 0,
      downloads_lifetime_with_mirrors: 400, downloads_per_month_with_mirrors: 40,
      downloads_last_day_with_mirrors: 8, downloads_current_day_with_mirrors: 2
    };
    const r = await getPyPIStats('pkg', cached, '', stubFetcher([
      ['https://pypi.org/pypi/pkg/json', pypiMeta],
      ['https://pepy.tech/api/v2/projects/pkg', pepyOk]
    ]), true);
    assert.equal(r.downloads_source, 'cache');
    assert.equal(r.downloads_lifetime, 50);
    assert.equal(r.downloads_lifetime_with_mirrors, 400);
    assert.equal(r.headlines_real_only, true);
  });

  it('resolves a default-mode cache hit to cached headlines', async () => {
    const cached = {
      headlines_real_only: false,
      downloads_lifetime: 400, downloads_per_month: 40, downloads_last_day: 8, downloads_current_day: 2,
      downloads_lifetime_real: 50, downloads_per_month_real: 5, downloads_last_day_real: 1, downloads_current_day_real: 0,
      downloads_lifetime_with_mirrors: 400, downloads_per_month_with_mirrors: 40,
      downloads_last_day_with_mirrors: 8, downloads_current_day_with_mirrors: 2
    };
    const full = await getPyPIStats('pkg', cached, '', stubFetcher([
      ['https://pypi.org/pypi/pkg/json', pypiMeta]
    ]));
    assert.equal(full.downloads_lifetime, 400);
    assert.equal(full.downloads_lifetime_real, 50);
    const real = await getPyPIStats('pkg', cached, '', stubFetcher([
      ['https://pypi.org/pypi/pkg/json', pypiMeta]
    ]), true);
    assert.equal(real.downloads_lifetime, 50);
    assert.equal(real.downloads_lifetime_with_mirrors, 400);
  });
});

describe('realOnly footer + computeMetrics flag', () => {
  it('footer notes the real-only view and computeMetrics flags mirrors', async () => {
    const row = {
      package: 'pkg', first_version: 'v1', first_date: 'd', current_version: 'v1',
      current_date: 'd', days_live: 1, downloads_last_day: 1, downloads_current_day: 0,
      downloads_per_month: 5, downloads_lifetime: 50, downloads_stale: false, runs_30d: null
    };
    const sum = { count: 1, avg_days_live: 1, avg_last_day: 1, avg_current_day: 0, avg_month: 5, avg_lifetime: 50, total_lifetime: 50 };
    const data = { pypi: [row], npm: [], summary: { pypi: sum, npm: sum, all: sum } };
    const out = renderTable(data, { realOnly: true });
    assert.ok(out.includes('--real-only'));
    assert.ok(!renderTable(data, {}).includes('--real-only'));

    const f = stubFetcher([
      ['https://pypi.org/pypi/pkg/json', pypiMeta],
      ['https://pypistats.org/api/packages/pkg/overall', { data: [
        { date: TODAY, category: 'without_mirrors', downloads: 11 },
        { date: TODAY, category: 'with_mirrors', downloads: 110 }
      ] }]
    ]);
    const def = await computeMetrics({ pip: ['pkg'] }, {}, f, {});
    assert.equal(def.mirrors_included, true);
    assert.equal(def.pypi[0].downloads_lifetime, 110);
    const real = await computeMetrics({ pip: ['pkg'] }, {}, f, { realOnly: true });
    assert.equal(real.mirrors_included, false);
    assert.equal(real.pypi[0].downloads_lifetime, 11);
  });
});

describe('pepy footer notice', () => {
  it('names pepy-fallback rows in the footer', () => {
    const row = {
      package: 'pkg', first_version: 'v1', first_date: 'd', current_version: 'v1',
      current_date: 'd', days_live: 1, downloads_last_day: 20, downloads_current_day: 3,
      downloads_per_month: 35, downloads_lifetime: 100, downloads_stale: false,
      downloads_source: 'pepy-fallback', runs_30d: null
    };
    const sum = { count: 1, avg_days_live: 1, avg_last_day: 20, avg_current_day: 3, avg_month: 35, avg_lifetime: 100, total_lifetime: 100 };
    const out = renderTable({ pypi: [row], npm: [], summary: { pypi: sum, npm: sum, all: sum } }, {});
    assert.ok(out.includes('pepy.tech fallback'));
    assert.ok(out.includes('pkg'));
  });
});
