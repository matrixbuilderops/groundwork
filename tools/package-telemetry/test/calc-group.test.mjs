import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calcGroup } from '../src/telemetry.mjs';

const pkg = (overrides = {}) => ({
  downloads_lifetime: 100,
  downloads_per_month: 30,
  downloads_last_day: 5,
  downloads_per_day: 5,
  downloads_current_day: 1,
  days_live: 10,
  ...overrides
});

describe('calcGroup', () => {
  it('returns zeros for an empty group', () => {
    const g = calcGroup([]);
    assert.equal(g.count, 0);
    assert.equal(g.total_lifetime, 0);
    assert.equal(g.total_month, 0);
    assert.equal(g.total_last_day, 0);
    assert.equal(g.total_current_day, 0);
    assert.equal(g.total_day, 0);
    assert.equal(g.avg_lifetime, 0);
    assert.equal(g.avg_month, 0);
    assert.equal(g.avg_last_day, 0);
    assert.equal(g.avg_current_day, 0);
    assert.equal(g.avg_day, 0);
    assert.equal(g.avg_days_live, 0);
  });

  it('sums totals across items', () => {
    const g = calcGroup([pkg(), pkg({ downloads_lifetime: 300, downloads_per_month: 60, downloads_last_day: 15, downloads_current_day: 3, days_live: 20 })]);
    assert.equal(g.count, 2);
    assert.equal(g.total_lifetime, 400);
    assert.equal(g.total_month, 90);
    assert.equal(g.total_last_day, 20);
    assert.equal(g.total_current_day, 4);
  });

  it('averages per-package metrics', () => {
    const g = calcGroup([pkg(), pkg({ downloads_lifetime: 300, downloads_per_month: 60, downloads_last_day: 15, downloads_current_day: 3, days_live: 20 })]);
    assert.equal(g.avg_lifetime, 200);
    assert.equal(g.avg_month, 45);
    assert.equal(g.avg_last_day, 10);
    assert.equal(g.avg_current_day, 2);
    assert.equal(g.avg_days_live, 15);
  });

  it('falls back to downloads_per_day when downloads_last_day is missing', () => {
    const g = calcGroup([pkg({ downloads_last_day: undefined, downloads_per_day: 7 })]);
    assert.equal(g.total_last_day, 7);
    assert.equal(g.avg_last_day, 7);
  });

  it('treats missing download fields as zero', () => {
    const g = calcGroup([{}]);
    assert.equal(g.count, 1);
    assert.equal(g.total_lifetime, 0);
    assert.equal(g.total_month, 0);
    assert.equal(g.total_last_day, 0);
    assert.equal(g.avg_days_live, 0);
  });

  it('emits no dead exec_* fields', () => {
    for (const g of [calcGroup([]), calcGroup([pkg()])]) {
      for (const key of Object.keys(g)) {
        assert.ok(!key.includes('exec'), `unexpected exec field: ${key}`);
      }
    }
  });
});
