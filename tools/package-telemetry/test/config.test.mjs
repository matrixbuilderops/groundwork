import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveConfigPath } from '../src/telemetry.mjs';

const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-config-'));

describe('loadConfig', () => {
  it('loads valid JSON config', () => {
    const dir = mkTemp();
    const file = path.join(dir, 'packages.json');
    fs.writeFileSync(file, JSON.stringify({ pip: ['a'], npx: ['b'] }));
    assert.deepEqual(loadConfig(file), { pip: ['a'], npx: ['b'] });
  });

  it('throws on corrupt JSON instead of silently using defaults', () => {
    const dir = mkTemp();
    const file = path.join(dir, 'packages.json');
    fs.writeFileSync(file, '{ not valid json');
    assert.throws(() => loadConfig(file), /Invalid JSON in config file/);
  });

  it('returns built-in defaults when the file does not exist', () => {
    const cfg = loadConfig(path.join(mkTemp(), 'missing.json'));
    assert.ok(Array.isArray(cfg.pip) && cfg.pip.length > 0);
    assert.ok(Array.isArray(cfg.npx) && cfg.npx.length > 0);
  });
});

describe('resolveConfigPath', () => {
  it('warns when an explicit --config path does not exist', () => {
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    try {
      const resolved = resolveConfigPath('/definitely/not/here-xyz-123.json');
      assert.ok(warnings.some((w) => w.includes('--config path not found')));
      assert.notEqual(resolved, '/definitely/not/here-xyz-123.json');
    } finally {
      console.warn = realWarn;
    }
  });

  it('resolves an existing explicit path without warning', () => {
    const dir = mkTemp();
    const file = path.join(dir, 'packages.json');
    fs.writeFileSync(file, '{}');
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    try {
      assert.equal(resolveConfigPath(file), path.resolve(file));
      assert.equal(warnings.length, 0);
    } finally {
      console.warn = realWarn;
    }
  });
});
