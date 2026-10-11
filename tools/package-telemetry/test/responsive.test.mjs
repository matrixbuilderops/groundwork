import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickColumns,
  resolveRenderWidth,
  renderTable
} from '../src/telemetry.mjs';

describe('pickColumns', () => {
  it('returns every column when width is null or huge', () => {
    for (const width of [null, undefined, 1000]) {
      const full = pickColumns({ runs: false, width });
      assert.equal(full.cols.length, 11);
      assert.deepEqual(full.dropped, []);
      assert.equal(full.fits, true);
      const runs = pickColumns({ runs: true, width });
      assert.equal(runs.cols.length, 16);
      assert.deepEqual(runs.dropped, []);
    }
  });

  it('drops meta columns lowest-priority-first, never stat columns', () => {
    const one = pickColumns({ runs: false, width: 147 });
    assert.deepEqual(one.dropped, ['First Date']);
    assert.equal(one.cols.length, 10);
    const narrow = pickColumns({ runs: false, width: 81 });
    assert.deepEqual(narrow.dropped, ['First Date', 'First Rel.', 'Days Live', 'Updated', 'Current']);
    assert.equal(narrow.fits, true);
    const ids = narrow.cols.map(c => c.id);
    for (const keep of ['type', 'pkg', 'lastday', 'today', 'month', 'life']) {
      assert.ok(ids.includes(keep), `dropped keeper ${keep}`);
    }
  });

  it('shrinks the package column before giving up, then reports needed width', () => {
    const shrunk = pickColumns({ runs: false, width: 79 });
    assert.equal(shrunk.cols.find(c => c.id === 'pkg').width, 15);
    assert.equal(shrunk.fits, true);
    const tiny = pickColumns({ runs: false, width: 60 });
    assert.equal(tiny.fits, false);
    assert.equal(tiny.neededWidth, 76);
    assert.equal(tiny.cols.find(c => c.id === 'pkg').width, 12);
  });

  it('keeps every runs partner + rank even when overflowing', () => {
    const r = pickColumns({ runs: true, width: 80 });
    const ids = r.cols.map(c => c.id);
    for (const keep of ['rday', 'rtoday', 'r30d', 'rlife', 'rank']) {
      assert.ok(ids.includes(keep), `dropped keeper ${keep}`);
    }
    assert.equal(r.fits, false);
    assert.equal(r.neededWidth, 134);
  });
});

describe('resolveRenderWidth', () => {
  it('--full and pipes render full, TTY renders to terminal width', () => {
    assert.equal(resolveRenderWidth({ full: true, columns: 80, isTTY: true }), null);
    assert.equal(resolveRenderWidth({ full: false, columns: 80, isTTY: false }), null);
    assert.equal(resolveRenderWidth({ full: false, columns: 120, isTTY: true }), 120);
    assert.equal(resolveRenderWidth({ full: false, columns: undefined, isTTY: true }), 80);
  });
});

describe('renderTable responsive', () => {
  const row = (over = {}) => ({
    package: 'sorrell-engine-mcp', first_version: 'v1', first_date: 'd', current_version: 'v1',
    current_date: 'd', days_live: 37, downloads_last_day: 1, downloads_current_day: 0,
    downloads_per_month: 27, downloads_lifetime: 192,
    runs_last_day: 0, runs_last_day_date: '2026-10-09', runs_today: null,
    runs_30d: 6, runs_stale: false, runs_rank: 2900000, runs_rank_prev: null,
    ...over
  });
  const sum = { count: 1, avg_days_live: 37, avg_last_day: 1, avg_current_day: 0, avg_month: 27, avg_lifetime: 192, total_lifetime: 192 };
  const data = {
    pypi: [row({ package: 'cli-fleet' })],
    npm: [row()],
    summary: { pypi: sum, npm: sum, all: { ...sum, count: 2 } }
  };

  it('renders full output by default (back-compat)', () => {
    const out = renderTable(data, {});
    assert.ok(out.includes('First Date'));
    assert.ok(out.includes('Total Lifetime DL'));
    assert.ok(!out.includes('compact: hid'));
  });

  it('compacts at width 80: meta gone, stats kept, note shown', () => {
    const out = renderTable(data, { width: 80 });
    const headerLine = out.split('\n').find(l => l.includes('Package'));
    assert.ok(!headerLine.includes('First Date'));
    assert.ok(!headerLine.includes('First Rel.'));
    assert.ok(headerLine.includes('Lifetime DL'));
    assert.ok(out.includes('Total DL'));
    assert.ok(!out.includes('Total Lifetime DL'));
    assert.ok(out.includes('compact: hid'));
    assert.ok(out.includes('5 cols'));
    assert.ok(out.includes('First Date'));
    assert.ok(out.includes('--full'));
    assert.ok(out.includes('sorrell-engine-…'));
  });

  it('every line fits the requested width', () => {
    const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
    for (const w of [80, 100]) {
      for (const line of strip(renderTable(data, { width: w })).split('\n')) {
        assert.ok(line.length <= w, `overflow (${line.length} > ${w}): ${line.slice(0, 60)}`);
      }
    }
  });

  it('compact summary drops suffixes, long labels and Avg Now', () => {
    const out = renderTable(data, { width: 80 });
    assert.ok(!out.includes('Avg Now'));
    assert.ok(!out.includes(' / pkg'));
    assert.ok(!out.includes('PyPI (pip)'));
    const full = renderTable(data, {});
    assert.ok(full.includes('Avg Today'));
    assert.ok(full.includes('PyPI (pip)'));
  });

  it('runs mode at 80 keeps every runs column and reports the overflow', () => {
    const out = renderTable(data, { runs: true, width: 80 });
    for (const h of ['R-Day', 'R-Today', 'R-30d', 'R-Life', 'CDN Rank']) {
      assert.ok(out.includes(h), `missing ${h}`);
    }
    assert.ok(out.includes('needs 134'));
  });
});
