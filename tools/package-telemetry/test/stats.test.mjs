import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchJson,
  formatVersion,
  getPyPIStats,
  getNPMStats,
  __resetDnsFallbackForTests
} from '../src/telemetry.mjs';

const isoDay = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
};

// --- formatVersion ---

describe('formatVersion', () => {
  it('renders unknown versions as bare N/A (never vN/A)', () => {
    assert.equal(formatVersion('N/A'), 'N/A');
    assert.equal(formatVersion(null), 'N/A');
    assert.equal(formatVersion(undefined), 'N/A');
    assert.equal(formatVersion(''), 'N/A');
  });

  it('keeps a single leading v on known versions', () => {
    assert.equal(formatVersion('1.2.3'), 'v1.2.3');
    assert.equal(formatVersion('v1.2.3'), 'v1.2.3');
  });
});

// --- PyPI mirror split (stubbed fetcher, no network) ---

const pypiMeta = {
  info: { version: '2.0.0', summary: 'stub' },
  releases: {
    '1.0.0': [{ upload_time_iso_8601: '2026-01-05T00:00:00' }],
    '2.0.0': [{ upload_time_iso_8601: '2026-02-05T00:00:00' }]
  }
};

const pypiStats = (dates) => ({
  data: dates.flatMap(({ day, plain, mirrors }) => [
    { category: 'without_mirrors', date: day, downloads: plain },
    { category: 'with_mirrors', date: day, downloads: mirrors }
  ])
});

describe('getPyPIStats mirror handling', () => {
  it('headlines without_mirrors and reports with_mirrors alongside', async () => {
    const dates = [
      { day: isoDay(-3), plain: 10, mirrors: 100 },
      { day: isoDay(-2), plain: 20, mirrors: 200 },
      { day: isoDay(-1), plain: 30, mirrors: 300 }
    ];
    const fetcher = async (url) => (url.includes('pypistats') ? pypiStats(dates) : pypiMeta);
    const r = await getPyPIStats('stub-pkg', null, '', fetcher);
    assert.equal(r.downloads_lifetime, 60);
    assert.equal(r.downloads_per_month, 60);
    assert.equal(r.downloads_last_day, 30);
    assert.equal(r.downloads_last_day_date, isoDay(-1));
    assert.equal(r.downloads_lifetime_with_mirrors, 600);
    assert.equal(r.downloads_per_month_with_mirrors, 600);
    assert.equal(r.downloads_last_day_with_mirrors, 300);
    assert.equal(r.downloads_stale, false);
    assert.equal(r.downloads_error, null);
    assert.equal(r.meta_error, null);
  });

  it('uses strict last calendar day before today even when it is zero', async () => {
    const dates = [
      { day: isoDay(-2), plain: 50, mirrors: 500 },
      { day: isoDay(-1), plain: 0, mirrors: 0 }
    ];
    const fetcher = async (url) => (url.includes('pypistats') ? pypiStats(dates) : pypiMeta);
    const r = await getPyPIStats('stub-pkg', null, '', fetcher);
    assert.equal(r.downloads_last_day, 0);
    assert.equal(r.downloads_last_day_date, isoDay(-1));
  });
});

// --- npm strict last-day (stubbed fetcher, no network) ---

const npmMeta = {
  'dist-tags': { latest: '2.0.0' },
  description: 'stub',
  time: {
    created: '2020-01-01T00:00:00.000Z',
    modified: '2026-02-05T00:00:00.000Z',
    '1.0.0': '2020-06-01T00:00:00.000Z',
    '2.0.0': '2026-02-05T00:00:00.000Z'
  }
};

describe('getNPMStats last-day handling', () => {
  it('uses strict last calendar day before today (no zero-skipping)', async () => {
    const range = {
      downloads: [
        { day: isoDay(-3), downloads: 42 },
        { day: isoDay(-2), downloads: 17 },
        { day: isoDay(-1), downloads: 0 },
        { day: isoDay(0), downloads: 3 }
      ]
    };
    const fetcher = async (url) => (url.includes('api.npmjs.org') ? range : npmMeta);
    const r = await getNPMStats('stub-pkg', null, '', fetcher);
    assert.equal(r.downloads_last_day, 0);
    assert.equal(r.downloads_last_day_date, isoDay(-1));
    assert.equal(r.downloads_current_day, 3);
    assert.equal(r.meta_error, null);
  });

  it('sorts versions chronologically for first release', async () => {
    const shuffled = {
      ...npmMeta,
      time: {
        created: '2020-01-01T00:00:00.000Z',
        modified: '2026-02-05T00:00:00.000Z',
        '2.0.0': '2026-02-05T00:00:00.000Z',
        '1.0.0': '2020-06-01T00:00:00.000Z'
      }
    };
    const fetcher = async (url) => (url.includes('api.npmjs.org')
      ? { downloads: [{ day: isoDay(-1), downloads: 1 }] }
      : shuffled);
    const r = await getNPMStats('stub-pkg', null, '', fetcher);
    assert.equal(r.first_version, 'v1.0.0');
    assert.equal(r.first_date, '2020-06-01');
  });
});

// --- meta_error + stale fallback (stubbed fetcher, no network) ---

describe('metadata errors and stale fallback', () => {
  it('records meta_error when registry metadata fails', async () => {
    const range = { downloads: [{ day: isoDay(-1), downloads: 9 }] };
    const fetcher = async (url) => (url.includes('api.npmjs.org')
      ? range
      : { _error: 'HTTP 404: Not Found' });
    const r = await getNPMStats('bogus-stub', null, '', fetcher);
    assert.equal(r.meta_error, 'HTTP 404: Not Found');
    assert.equal(r.current_version, 'N/A');
    assert.equal(r.downloads_lifetime, 9);
  });

  it('falls back to cached numbers (both mirror series) when downloads fail', async () => {
    const cache = {
      first_version: 'v1.0.0',
      first_date: '2026-01-05',
      current_version: 'v2.0.0',
      current_date: '2026-02-05',
      total_releases: 2,
      description: 'cached',
      downloads_lifetime: 111,
      downloads_per_month: 22,
      downloads_last_day: 3,
      downloads_last_day_date: '2026-10-01',
      downloads_current_day: 1,
      downloads_lifetime_with_mirrors: 999,
      downloads_per_month_with_mirrors: 200,
      downloads_last_day_with_mirrors: 30,
      downloads_current_day_with_mirrors: 9
    };
    const fetcher = async () => ({ _error: 'boom' });
    const r = await getPyPIStats('stub-pkg', cache, '', fetcher);
    assert.equal(r.downloads_stale, true);
    assert.equal(r.downloads_lifetime, 111);
    assert.equal(r.downloads_per_month, 22);
    assert.equal(r.downloads_last_day, 3);
    assert.equal(r.downloads_lifetime_with_mirrors, 999);
    assert.equal(r.downloads_per_month_with_mirrors, 200);
    assert.equal(r.downloads_error, 'boom');
    assert.equal(r.meta_error, 'boom');
  });

  it('records point-API fallback errors instead of dropping them', async () => {
    const fetcher = async (url) => {
      if (url.includes('registry.npmjs.org')) return npmMeta;
      return { _error: 'HTTP 503: Service Unavailable' };
    };
    const r = await getNPMStats('stub-pkg', null, '', fetcher);
    assert.match(r.downloads_error, /HTTP 503/);
    assert.match(r.downloads_error, /last-day/);
    assert.match(r.downloads_error, /last-month/);
  });
});

// --- fetchJson retry semantics (stubbed global fetch) ---

describe('fetchJson', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetDnsFallbackForTests();
  });

  const okResponse = (body) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body
  });
  const errResponse = (status, statusText) => ({
    ok: false,
    status,
    statusText,
    json: async () => ({})
  });

  it('retries HTTP 429 then succeeds', async () => {
    let calls = 0;
    globalThis.fetch = async () => (++calls < 3
      ? errResponse(429, 'Too Many Requests')
      : okResponse({ hello: 'world' }));
    const out = await fetchJson('https://example.test/x', 4, 0);
    assert.deepEqual(out, { hello: 'world' });
    assert.equal(calls, 3);
  });

  it('retries HTTP 503 up to maxRetries then reports the error', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return errResponse(503, 'Service Unavailable');
    };
    const out = await fetchJson('https://example.test/x', 2, 0);
    assert.equal(out._error, 'HTTP 503: Service Unavailable');
    assert.equal(calls, 2);
  });

  it('does not retry HTTP 404', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return errResponse(404, 'Not Found');
    };
    const out = await fetchJson('https://example.test/x', 4, 0);
    assert.equal(out._error, 'HTTP 404: Not Found');
    assert.equal(calls, 1);
  });
});
