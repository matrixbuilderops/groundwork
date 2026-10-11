import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'bin', 'cli.mjs');

// End-to-end: bogus fixture packages can never resolve on a registry, so any
// network outcome (404, rate limit, offline) must yield stale cache fallback
// — and --no-save must leave the fixture cache byte-identical.
describe('cli --no-save fixture run', () => {
  it('serves stale fixture cache without writing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-cli-'));
    const configPath = path.join(dir, 'packages.json');
    const cachePath = path.join(dir, 'package_telemetry_latest.json');
    fs.copyFileSync(path.join(here, 'fixtures', 'packages.json'), configPath);
    fs.copyFileSync(path.join(here, 'fixtures', 'package_telemetry_latest.json'), cachePath);
    const cacheBefore = fs.readFileSync(cachePath, 'utf8');

    const { stdout } = await execFileAsync(
      process.execPath,
      [CLI, '--config', configPath, '--no-save', '--json'],
      { cwd: dir, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }
    );
    const data = JSON.parse(stdout);

    assert.equal(data.pypi.length, 1);
    assert.equal(data.npm.length, 1);
    for (const row of [...data.pypi, ...data.npm]) {
      assert.equal(row.downloads_stale, true);
      assert.ok(row.downloads_error || row.meta_error, 'expected a recorded error');
    }
    assert.equal(data.pypi[0].downloads_lifetime, 700);
    assert.equal(data.pypi[0].downloads_lifetime_with_mirrors, 7000);
    assert.equal(data.npm[0].downloads_lifetime, 500);

    // --no-save: cache file untouched.
    assert.equal(fs.readFileSync(cachePath, 'utf8'), cacheBefore);
  });
});
