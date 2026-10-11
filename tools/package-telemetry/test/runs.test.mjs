import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getJsdelivrRuns,
  getNPMStats,
  computeMetrics,
  renderTable
} from '../src/telemetry.mjs';

const jsdelivrOk = {
  hits: {
    total: 130,
    dates: { '2026-09-12': 100, '2026-10-11': 30 }
  }
};

const npmMeta = {
  'dist-tags': { latest: '1.0.0' },
  description: 'stub',
  time: { created: '2026-01-01T00:00:00.000Z', modified: '2026-02-01T00:00:00.000Z', '1.0.0': '2026-01-05T00:00:00.000Z' }
};

const npmDl = (days) => ({ downloads: days.map(([day, downloads]) => ({ day, downloads })) });

const stubFetcher = (routes) => async (url) => {
  for (const [prefix, body] of routes) {
    if (url.startsWith(prefix)) return body;
  }
  return { _error: `unstubbed: ${url}` };
};

describe('getJsdelivrRuns', () => {
  it('reads total + window from the stats payload', async () => {
    const r = await getJsdelivrRuns('pkg', null, stubFetcher([
      ['https://data.jsdelivr.com/v1/stats/packages/npm/pkg', jsdelivrOk]
    ]));
    assert.equal(r.runs_30d, 130);
    assert.equal(r.runs_window, '2026-09-12..2026-10-11');
    assert.equal(r.runs_stale, false);
    assert.equal(r.runs_error, null);
  });

  it('sums daily hits when total is missing', async () => {
    const r = await getJsdelivrRuns('pkg', null, stubFetcher([
      ['https://data.jsdelivr.com/', { hits: { dates: { a: 5, b: 7 } } }]
    ]));
    assert.equal(r.runs_30d, 12);
  });

  it('falls back to cache on error, else zero with error recorded', async () => {
    const err = stubFetcher([]);
    const s = await getJsdelivrRuns('pkg', { runs_30d: 44, runs_window: 'w' }, err);
    assert.equal(s.runs_30d, 44);
    assert.equal(s.runs_stale, true);
    const z = await getJsdelivrRuns('pkg', null, err);
    assert.equal(z.runs_30d, 0);
    assert.ok(z.runs_error);
  });
});

describe('runs wiring', () => {
  const npmRoutes = [
    ['https://registry.npmjs.org/pkg', npmMeta],
    ['https://api.npmjs.org/downloads/range/', npmDl([['2026-10-10', 9]])],
    ['https://data.jsdelivr.com/', jsdelivrOk]
  ];

  it('getNPMStats fetches runs only when asked', async () => {
    const f = stubFetcher(npmRoutes);
    const without = await getNPMStats('pkg', null, '', f, false);
    assert.equal(without.runs_30d, null);
    const withRuns = await getNPMStats('pkg', null, '', f, true);
    assert.equal(withRuns.runs_30d, 130);
  });

  it('computeMetrics threads wantRuns into npm rows', async () => {
    const f = stubFetcher(npmRoutes);
    const data = await computeMetrics({ npm: ['pkg'] }, {}, f, { wantRuns: true });
    assert.equal(data.npm[0].runs_30d, 130);
    assert.equal(data.summary.npm.total_runs_30d, 130);
  });
});

describe('renderTable runs column', () => {
  const data = {
    pypi: [{ package: 'a', first_version: 'v1', first_date: 'd', current_version: 'v1', current_date: 'd', days_live: 1, downloads_last_day: 1, downloads_current_day: 0, downloads_per_month: 2, downloads_lifetime: 3, runs_30d: null }],
    npm: [{ package: 'b', first_version: 'v1', first_date: 'd', current_version: 'v1', current_date: 'd', days_live: 1, downloads_last_day: 1, downloads_current_day: 0, downloads_per_month: 2, downloads_lifetime: 3, runs_30d: 130, runs_stale: false }],
    summary: { pypi: { count: 1, avg_days_live: 1, avg_last_day: 1, avg_current_day: 0, avg_month: 2, avg_lifetime: 3, total_lifetime: 3 }, npm: { count: 1, avg_days_live: 1, avg_last_day: 1, avg_current_day: 0, avg_month: 2, avg_lifetime: 3, total_lifetime: 3 }, all: { count: 2, avg_days_live: 1, avg_last_day: 2, avg_current_day: 0, avg_month: 4, avg_lifetime: 6, total_lifetime: 6 } }
  };

  it('shows Runs 30d with values + n/a only when runs:true', () => {
    const on = renderTable(data, { runs: true });
    assert.ok(on.includes('Runs 30d'));
    assert.ok(on.includes('130'));
    assert.ok(on.includes('n/a'));
    assert.ok(!on.includes('Runs column: --runs'));
    const off = renderTable(data, {});
    assert.ok(!off.includes('Runs 30d'));
    assert.ok(off.includes('Runs column: --runs'));
  });
});
