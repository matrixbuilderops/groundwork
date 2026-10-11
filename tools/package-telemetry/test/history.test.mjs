import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendHistory,
  loadHistory,
  computeTrend,
  renderTrend
} from '../src/telemetry.mjs';

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

const row = (over = {}) => ({
  package: 'pkg-a', downloads_last_day: 1, downloads_current_day: 0,
  downloads_per_month: 30, downloads_lifetime: 100, downloads_stale: false,
  downloads_source: 'pypistats', runs_30d: null, runs_rank: null,
  ...over
});

const snapData = (rows, ts = iso(Date.now())) => ({
  timestamp: ts,
  mirrors_included: true,
  pypi: rows,
  npm: [],
  summary: {
    pypi: { total_lifetime: 100, total_month: 30 },
    npm: { total_lifetime: 0, total_month: 0 },
    all: { total_lifetime: 100, total_month: 30 }
  }
});

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')), 'h.jsonl');

describe('appendHistory', () => {
  it('appends a lean snapshot line', () => {
    const f = tmpFile();
    assert.equal(appendHistory(snapData([row()]), f), true);
    const line = JSON.parse(fs.readFileSync(f, 'utf8').trim());
    assert.ok(line.ts);
    assert.equal(line.mirrors_included, true);
    assert.equal(line.sources_mixed, false);
    assert.deepEqual(line.packages['pkg-a'], { life: 100, month: 30, last: 1, today: 0, runs30: null, rank: null });
    assert.deepEqual(line.totals, { life: 100, month: 30 });
  });

  it('refuses to record when any row is stale', () => {
    const f = tmpFile();
    assert.equal(appendHistory(snapData([row({ downloads_stale: true })]), f), false);
    assert.equal(fs.existsSync(f), false);
  });

  it('flags pepy-mixed snapshots and prunes beyond cap', () => {
    const f = tmpFile();
    const mixed = snapData([row({ downloads_source: 'pepy-fallback' })]);
    assert.equal(appendHistory(mixed, f, 3), true);
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8').trim()).sources_mixed, true);
    for (let i = 0; i < 4; i++) appendHistory(snapData([row()]), f, 3);
    assert.equal(fs.readFileSync(f, 'utf8').trim().split('\n').length, 3);
  });
});

describe('loadHistory', () => {
  it('returns [] when missing and skips corrupt lines', () => {
    assert.deepEqual(loadHistory('/nonexistent-dir-xyz/h.jsonl'), []);
    const f = tmpFile();
    fs.writeFileSync(f, '{"ts":"2026-01-01T00:00:00.000Z","packages":{}}\nNOT JSON\n{"nope":true}\n');
    const h = loadHistory(f);
    assert.equal(h.length, 1);
    assert.equal(h[0].ts.slice(0, 10), '2026-01-01');
  });
});

describe('computeTrend', () => {
  const now = Date.parse('2026-10-11T12:00:00.000Z');
  const snap = (daysAgo, life, mirrors = true) => ({
    ts: iso(now - daysAgo * DAY),
    mirrors_included: mirrors,
    packages: { 'pkg-a': { life, month: 0, last: 0, today: 0, runs30: null, rank: null } }
  });

  it('deltas against the nearest snapshot at or before each window', () => {
    const history = [snap(40, 10), snap(20, 50), snap(3, 90)];
    const t = computeTrend(history, { 'pkg-a': 100 }, { now });
    assert.equal(t.rows[0].d7, 10);
    assert.equal(t.rows[0].d30, 50);
    assert.equal(t.count, 3);
  });

  it('filters by mode and falls back to oldest when history is short', () => {
    const history = [snap(40, 10, false), snap(2, 80)];
    const t = computeTrend(history, { 'pkg-a': 100 }, { now });
    assert.equal(t.rows[0].d7, 20);
    assert.equal(t.rows[0].d30, 20);
    assert.equal(t.count, 1);
  });
});

describe('renderTrend', () => {
  it('renders deltas + oldest note, or the empty-history message', () => {
    const now = Date.now();
    const history = [{
      ts: iso(now - 10 * DAY), mirrors_included: true,
      packages: { 'pkg-a': { life: 60, month: 0, last: 0, today: 0, runs30: null, rank: null } }
    }];
    const data = snapData([row()]);
    const out = renderTrend(data, history, {});
    assert.ok(out.includes('pkg-a'));
    assert.ok(out.includes('+40'));
    assert.ok(out.includes('snapshots: 1'));
    const empty = renderTrend(data, [], {});
    assert.ok(empty.includes('No history yet'));
  });
});
