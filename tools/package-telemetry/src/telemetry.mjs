import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_FILE = path.join(PACKAGE_ROOT, 'packages.json');

const HEADERS = {
  'User-Agent': 'PackageTelemetry/2.0 (+https://github.com/matrixbuilderops)'
};

let _dnsFallbackApplied = false;

/**
 * Fallback DNS resolvers (Cloudflare 1.1.1.1, Google 8.8.8.8) applied when the
 * system resolver fails (SERVFAIL / ENOTFOUND / EAI_AGAIN). Uses dns.setServers
 * so retries keep the original hostname — TLS cert/SNI validation stays intact.
 */
export function applyDnsFallbackServers() {
  if (_dnsFallbackApplied) return;
  _dnsFallbackApplied = true;
  try {
    dns.setServers(['1.1.1.1', '8.8.8.8']);
  } catch {
    // Keep system resolvers if the swap fails.
  }
}

// Test-only: allow re-arming the one-shot DNS fallback between cases.
export function __resetDnsFallbackForTests() {
  _dnsFallbackApplied = false;
}

function isDnsError(err) {
  if (!err) return false;
  return err.code === 'ENOTFOUND' ||
    err.code === 'EAI_AGAIN' ||
    String(err.message || '').includes('getaddrinfo');
}

/**
 * Robust JSON fetcher with retry & DNS fallback.
 * Retries thrown network errors plus HTTP 429 / 5xx; fails fast on 404/4xx.
 */
export async function fetchJson(url, maxRetries = 4, delayMs = 100) {
  if (delayMs > 0) {
    await new Promise(r => setTimeout(r, delayMs));
  }
  let lastErr = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { ...HEADERS },
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        return await res.json();
      }
      const status = res.status || 0;
      lastErr = new Error(`HTTP ${status}: ${res.statusText}`);
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt >= maxRetries - 1) {
        return { _error: lastErr.message };
      }
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    } catch (err) {
      lastErr = err;
      if (isDnsError(err)) {
        applyDnsFallbackServers();
      }
      if (attempt >= maxRetries - 1) break;
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  return { _error: lastErr ? String(lastErr.message || lastErr) : 'Unknown network failure' };
}

/**
 * Normalize a version string for display. Unknown versions render as bare
 * "N/A" (never "vN/A"); known versions keep a single leading "v".
 */
export function formatVersion(ver) {
  if (ver === null || ver === undefined || ver === '' || ver === 'N/A') return 'N/A';
  const s = String(ver);
  return s.startsWith('v') ? s : `v${s}`;
}

export function calculateDaysBetween(dateStr) {
  if (!dateStr || dateStr === 'N/A') return 1;
  const target = new Date(dateStr);
  if (Number.isNaN(target.getTime())) return 1;
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - target.getTime());
  return Math.max(1, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
}

/**
 * Fetch PyPI stats and metadata.
 * Headline download numbers use pypistats `without_mirrors` (real installs);
 * mirror-inflated totals are reported alongside in `*_with_mirrors` fields.
 */
export async function getPyPIStats(pkgName, cachedPkg = null, configuredDesc = '', fetcher = fetchJson) {
  const pypiUrl = `https://pypi.org/pypi/${pkgName}/json`;
  const pypiData = await fetcher(pypiUrl, 3, 50);
  const metaError = pypiData._error || null;

  let firstVer = 'N/A';
  let firstDate = 'N/A';
  let latestVer = 'N/A';
  let latestDate = 'N/A';
  let totalReleases = 0;
  let apiDesc = '';

  if (!pypiData._error) {
    const releases = pypiData.releases || {};
    const versionDates = [];
    for (const [ver, files] of Object.entries(releases)) {
      if (Array.isArray(files) && files.length > 0) {
        const t = files[0].upload_time_iso_8601 || files[0].upload_time;
        if (t) versionDates.push([t.slice(0, 10), ver]);
      }
    }
    versionDates.sort((a, b) => a[0].localeCompare(b[0]));
    if (versionDates.length > 0) {
      [firstDate, firstVer] = versionDates[0];
    }
    latestVer = pypiData.info?.version || 'N/A';
    const latestFiles = releases[latestVer] || [];
    if (latestFiles.length > 0) {
      const t = latestFiles[0].upload_time_iso_8601 || latestFiles[0].upload_time || 'N/A';
      latestDate = t.slice(0, 10);
    } else if (versionDates.length > 0) {
      latestDate = versionDates[versionDates.length - 1][0];
    }
    totalReleases = versionDates.length;
    apiDesc = pypiData.info?.summary || '';
  } else if (cachedPkg) {
    firstVer = cachedPkg.first_version || 'N/A';
    firstDate = cachedPkg.first_date || 'N/A';
    latestVer = cachedPkg.current_version || 'N/A';
    latestDate = cachedPkg.current_date || 'N/A';
    totalReleases = cachedPkg.total_releases || 0;
    apiDesc = cachedPkg.description || '';
  }

  // Fetch daily downloads from pypistats overall API
  const statsUrl = `https://pypistats.org/api/packages/${pkgName}/overall`;
  const statsData = await fetcher(statsUrl, 3, 100);

  let lifetime = 0;
  let perMonth = 0;
  let lastDayDl = 0;
  let lastDayDate = 'N/A';
  let todayDl = 0;
  let lifetimeWithMirrors = 0;
  let perMonthWithMirrors = 0;
  let lastDayWithMirrors = 0;
  let todayWithMirrors = 0;
  const todayStr = new Date().toISOString().slice(0, 10);
  const daysActive = firstDate !== 'N/A' ? calculateDaysBetween(firstDate) : 1;

  if (!statsData._error && Array.isArray(statsData.data)) {
    const dataList = statsData.data;
    if (dataList.length > 0) {
      const byDate = {};
      const byDateWith = {};
      for (const d of dataList) {
        const dt = d.date || '';
        if (d.category === 'without_mirrors') {
          byDate[dt] = d.downloads || 0;
        } else if (d.category === 'with_mirrors') {
          byDateWith[dt] = d.downloads || 0;
        }
      }
      // Headline = real installs. Fall back to mirror counts only when the
      // API reports no without_mirrors rows at all (should not happen).
      const primary = Object.keys(byDate).length > 0 ? byDate : byDateWith;
      const sortedDates = Object.keys(primary).sort();
      lifetime = Object.values(primary).reduce((s, v) => s + v, 0);
      const last30Dates = sortedDates.slice(-30);
      perMonth = last30Dates.reduce((s, dt) => s + primary[dt], 0);

      // Check if today's date exists in registry
      todayDl = primary[todayStr] || 0;

      // Last finalized completed day (strictly before today)
      const pastDates = sortedDates.filter(dt => dt < todayStr);
      if (pastDates.length > 0) {
        lastDayDate = pastDates[pastDates.length - 1];
        lastDayDl = primary[lastDayDate];
      } else if (sortedDates.length > 0) {
        lastDayDate = sortedDates[sortedDates.length - 1];
        lastDayDl = primary[lastDayDate];
      }

      // Mirror-inflated series, reported alongside for transparency.
      const sortedWith = Object.keys(byDateWith).sort();
      lifetimeWithMirrors = Object.values(byDateWith).reduce((s, v) => s + v, 0);
      perMonthWithMirrors = sortedWith.slice(-30).reduce((s, dt) => s + byDateWith[dt], 0);
      todayWithMirrors = byDateWith[todayStr] || 0;
      const pastWith = sortedWith.filter(dt => dt < todayStr);
      if (pastWith.length > 0) {
        lastDayWithMirrors = byDateWith[pastWith[pastWith.length - 1]] || 0;
      } else if (sortedWith.length > 0) {
        lastDayWithMirrors = byDateWith[sortedWith[sortedWith.length - 1]] || 0;
      }
    }
  }

  const dlError = statsData._error || null;
  let stale = false;
  if (lifetime === 0 && cachedPkg && (cachedPkg.downloads_lifetime || 0) > 0) {
    lifetime = cachedPkg.downloads_lifetime || 0;
    perMonth = cachedPkg.downloads_per_month || 0;
    lastDayDl = cachedPkg.downloads_last_day || cachedPkg.downloads_per_day || 0;
    lastDayDate = cachedPkg.downloads_last_day_date || 'N/A';
    todayDl = cachedPkg.downloads_current_day || 0;
    lifetimeWithMirrors = cachedPkg.downloads_lifetime_with_mirrors || 0;
    perMonthWithMirrors = cachedPkg.downloads_per_month_with_mirrors || 0;
    lastDayWithMirrors = cachedPkg.downloads_last_day_with_mirrors || 0;
    todayWithMirrors = cachedPkg.downloads_current_day_with_mirrors || 0;
    stale = true;
  }

  const desc = configuredDesc || apiDesc || (cachedPkg?.description) || '';

  return {
    registry: 'PyPI (pip)',
    package: pkgName,
    first_version: formatVersion(firstVer),
    first_date: firstDate,
    current_version: formatVersion(latestVer),
    current_date: latestDate,
    days_live: daysActive,
    total_releases: totalReleases,
    downloads_last_day: lastDayDl,
    downloads_last_day_date: lastDayDate,
    downloads_current_day: todayDl,
    downloads_current_day_date: todayStr,
    downloads_per_day: lastDayDl,
    downloads_per_month: perMonth,
    downloads_lifetime: lifetime,
    downloads_last_day_with_mirrors: lastDayWithMirrors,
    downloads_current_day_with_mirrors: todayWithMirrors,
    downloads_per_month_with_mirrors: perMonthWithMirrors,
    downloads_lifetime_with_mirrors: lifetimeWithMirrors,
    downloads_stale: stale,
    downloads_error: dlError,
    meta_error: metaError,
    // PyPI publishes no execution counts and has no jsDelivr equivalent:
    // runs are honestly null, rendered as n/a, never zero-filled.
    runs_30d: null,
    runs_window: null,
    runs_stale: false,
    runs_error: null,
    description: desc,
    url: `https://pypi.org/project/${pkgName}/`
  };
}

/**
 * Fetch jsDelivr CDN hits as the "runs" proxy for an npm package. npm and
 * PyPI publish no execution counts, so runs = CDN file serves over the
 * trailing window jsDelivr reports (30 days). An install that is never
 * imported scores downloads but no runs; a browser/CI-fetched file scores
 * runs without an npm download — the two columns answer different questions.
 */
export async function getJsdelivrRuns(pkgName, cachedPkg = null, fetcher = fetchJson) {
  const url = `https://data.jsdelivr.com/v1/stats/packages/npm/${pkgName}`;
  const data = await fetcher(url, 3, 50);
  if (!data._error && data.hits && typeof data.hits === 'object') {
    const dates = Object.keys(data.hits.dates || {}).sort();
    const total = typeof data.hits.total === 'number'
      ? data.hits.total
      : Object.values(data.hits.dates || {}).reduce((s, n) => s + (n || 0), 0);
    return {
      runs_30d: total,
      runs_window: dates.length > 0 ? `${dates[0]}..${dates[dates.length - 1]}` : 'N/A',
      runs_stale: false,
      runs_error: null
    };
  }
  if (cachedPkg && (cachedPkg.runs_30d || 0) > 0) {
    return {
      runs_30d: cachedPkg.runs_30d || 0,
      runs_window: cachedPkg.runs_window || 'N/A',
      runs_stale: true,
      runs_error: data._error || null
    };
  }
  return { runs_30d: 0, runs_window: 'N/A', runs_stale: false, runs_error: data._error || null };
}

/**
 * Fetch NPM stats and metadata
 */
export async function getNPMStats(pkgName, cachedPkg = null, configuredDesc = '', fetcher = fetchJson, wantRuns = false) {
  const npmUrl = `https://registry.npmjs.org/${pkgName}`;
  const npmData = await fetcher(npmUrl, 3, 50);
  const metaError = npmData._error || null;

  let firstVer = 'N/A';
  let firstDate = 'N/A';
  let latestVer = 'N/A';
  let latestDate = 'N/A';
  let totalReleases = 0;
  let apiDesc = '';

  if (!npmData._error) {
    const timeMap = npmData.time || {};
    const versions = Object.keys(timeMap)
      .filter(v => v !== 'created' && v !== 'modified')
      .sort((a, b) => String(timeMap[a] || '').localeCompare(String(timeMap[b] || '')));
    if (versions.length > 0) {
      firstVer = versions[0];
      firstDate = (timeMap[firstVer] || timeMap.created || 'N/A').slice(0, 10);
    }
    latestVer = npmData['dist-tags']?.latest || 'N/A';
    latestDate = (timeMap[latestVer] || timeMap.modified || 'N/A').slice(0, 10);
    totalReleases = versions.length;
    apiDesc = npmData.description || '';
  } else if (cachedPkg) {
    firstVer = cachedPkg.first_version || 'N/A';
    firstDate = cachedPkg.first_date || 'N/A';
    latestVer = cachedPkg.current_version || 'N/A';
    latestDate = cachedPkg.current_date || 'N/A';
    totalReleases = cachedPkg.total_releases || 0;
    apiDesc = cachedPkg.description || '';
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const dlUrl = `https://api.npmjs.org/downloads/range/2020-01-01:${todayStr}/${pkgName}`;
  const dlData = await fetcher(dlUrl, 3, 50);

  let lifetime = 0;
  let perMonth = 0;
  let lastDayDl = 0;
  let lastDayDate = 'N/A';
  let todayDl = 0;
  const daysActive = firstDate !== 'N/A' ? calculateDaysBetween(firstDate) : 1;
  const pointErrors = [];

  if (!dlData._error && Array.isArray(dlData.downloads)) {
    let list = dlData.downloads;
    if (firstDate !== 'N/A') {
      list = list.filter(d => (d.day || '') >= firstDate);
    }
    if (list.length > 0) {
      lifetime = list.reduce((sum, d) => sum + (d.downloads || 0), 0);

      // Check if today's date exists in range
      const todayEntries = list.filter(d => d.day === todayStr);
      if (todayEntries.length > 0) {
        todayDl = todayEntries[0].downloads || 0;
      }

      // 30-day sum from range
      const last30 = list.slice(-30);
      perMonth = last30.reduce((sum, d) => sum + (d.downloads || 0), 0);

      // Strict last calendar day before today (matches PyPI; zero days count).
      const pastEntries = list.filter(d => (d.day || '') < todayStr);
      if (pastEntries.length > 0) {
        const lastEntry = pastEntries[pastEntries.length - 1];
        lastDayDl = lastEntry.downloads || 0;
        lastDayDate = lastEntry.day || 'N/A';
      } else if (list.length > 0) {
        const lastEntry = list[list.length - 1];
        lastDayDl = lastEntry.downloads || 0;
        lastDayDate = lastEntry.day || 'N/A';
      }
    }
  } else {
    // Only query point API if range query failed or was unavailable
    const dlDayData = await fetcher(`https://api.npmjs.org/downloads/point/last-day/${pkgName}`, 2, 50);
    if (!dlDayData._error) {
      lastDayDl = dlDayData.downloads || 0;
      lastDayDate = dlDayData.end || 'N/A';
    } else {
      pointErrors.push(`last-day: ${dlDayData._error}`);
    }

    const dlMonthData = await fetcher(`https://api.npmjs.org/downloads/point/last-month/${pkgName}`, 2, 50);
    if (!dlMonthData._error && (dlMonthData.downloads || 0) > 0) {
      perMonth = dlMonthData.downloads || 0;
    } else if (dlMonthData._error) {
      pointErrors.push(`last-month: ${dlMonthData._error}`);
    }
  }

  const dlError = [dlData._error, ...pointErrors].filter(Boolean).join('; ') || null;
  let stale = false;
  if (lifetime === 0 && cachedPkg && (cachedPkg.downloads_lifetime || 0) > 0) {
    lifetime = cachedPkg.downloads_lifetime || 0;
    perMonth = cachedPkg.downloads_per_month || 0;
    lastDayDl = cachedPkg.downloads_last_day || cachedPkg.downloads_per_day || 0;
    lastDayDate = cachedPkg.downloads_last_day_date || 'N/A';
    todayDl = cachedPkg.downloads_current_day || 0;
    stale = true;
  }

  const desc = configuredDesc || apiDesc || (cachedPkg?.description) || '';

  // Runs are fetched ONLY on request (--runs): one extra API call per
  // package. Otherwise null — never a silent cached number.
  let runs = { runs_30d: null, runs_window: null, runs_stale: false, runs_error: null };
  if (wantRuns) {
    runs = await getJsdelivrRuns(pkgName, cachedPkg, fetcher);
  }

  return {
    registry: 'NPM (npx)',
    package: pkgName,
    runs_30d: runs.runs_30d,
    runs_window: runs.runs_window,
    runs_stale: runs.runs_stale,
    runs_error: runs.runs_error,
    first_version: formatVersion(firstVer),
    first_date: firstDate,
    current_version: formatVersion(latestVer),
    current_date: latestDate,
    days_live: daysActive,
    total_releases: totalReleases,
    downloads_last_day: lastDayDl,
    downloads_last_day_date: lastDayDate,
    downloads_current_day: todayDl,
    downloads_current_day_date: todayStr,
    downloads_per_day: lastDayDl,
    downloads_per_month: perMonth,
    downloads_lifetime: lifetime,
    downloads_stale: stale,
    downloads_error: dlError,
    meta_error: metaError,
    description: desc,
    url: `https://www.npmjs.com/package/${pkgName}`
  };
}

export function calcGroup(items) {
  const n = items.length;
  if (n === 0) {
    return {
      count: 0,
      total_lifetime: 0,
      total_month: 0,
      total_last_day: 0,
      total_current_day: 0,
      total_day: 0,
      total_runs_30d: 0,
      avg_lifetime: 0,
      avg_month: 0,
      avg_last_day: 0,
      avg_current_day: 0,
      avg_day: 0,
      avg_days_live: 0,
      avg_runs_30d: 0
    };
  }
  const totLife = items.reduce((s, i) => s + (i.downloads_lifetime || 0), 0);
  const totRuns = items.reduce((s, i) => s + (i.runs_30d || 0), 0);
  const totMonth = items.reduce((s, i) => s + (i.downloads_per_month || 0), 0);
  const totLast = items.reduce((s, i) => s + (i.downloads_last_day ?? i.downloads_per_day ?? 0), 0);
  const totCur = items.reduce((s, i) => s + (i.downloads_current_day || 0), 0);
  const totDays = items.reduce((s, i) => s + (i.days_live || 0), 0);

  return {
    count: n,
    total_lifetime: totLife,
    total_month: totMonth,
    total_last_day: totLast,
    total_current_day: totCur,
    total_day: Math.round(totLast * 10) / 10,
    total_runs_30d: totRuns,
    avg_lifetime: Math.round((totLife / n) * 10) / 10,
    avg_runs_30d: Math.round((totRuns / n) * 10) / 10,
    avg_month: Math.round((totMonth / n) * 10) / 10,
    avg_last_day: Math.round((totLast / n) * 10) / 10,
    avg_current_day: Math.round((totCur / n) * 10) / 10,
    avg_day: Math.round((totLast / n) * 10) / 10,
    avg_days_live: Math.round((totDays / n) * 10) / 10
  };
}

/**
 * Resolve config from CLI option, cwd, user home, or package fallback.
 */
export function resolveConfigPath(customPath = null) {
  if (customPath) {
    if (fs.existsSync(customPath)) {
      return path.resolve(customPath);
    }
    console.warn(`Warning: --config path not found: ${customPath}; falling back to default resolution.`);
  }

  // 1. Current working directory
  const cwdPackages = path.join(process.cwd(), 'packages.json');
  if (fs.existsSync(cwdPackages)) return cwdPackages;

  const cwdPackagesConfig = path.join(process.cwd(), 'packages_config.json');
  if (fs.existsSync(cwdPackagesConfig)) return cwdPackagesConfig;

  // 2. User home directory (current name, then legacy name)
  const userConfig = path.join(os.homedir(), '.config', 'package-telemetry', 'packages.json');
  if (fs.existsSync(userConfig)) return userConfig;

  const legacyUserConfig = path.join(os.homedir(), '.config', 'pip-npx-stats', 'packages.json');
  if (fs.existsSync(legacyUserConfig)) return legacyUserConfig;

  // 3. Fallback to package bundled config
  if (fs.existsSync(DEFAULT_CONFIG_FILE)) return DEFAULT_CONFIG_FILE;

  return cwdPackages;
}

export function loadConfig(configPath) {
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON in config file ${configPath}: ${err.message}`);
    }
  }

  return {
    pip: [
      'cli-enforcement',
      'cli-wikia',
      'cli-collective',
      'cli-fleet'
    ],
    npx: [
      'starforge-cli',
      'sitemap-mcp',
      'filelens-mcp',
      'starreckon',
      'verifier-mcp',
      'sorrell-engine-mcp',
      'package-telemetry'
    ],
    descriptions: {
      'cli-enforcement': 'Model-agnostic hook-level behavioral enforcement engine for AI coding agents.',
      'cli-wikia': 'Offline, pip-installable reference wiki & search index for AI CLIs (Claude, Gemini, Copilot, DeepSeek).',
      'cli-collective': 'The Collective bundle: knowledge (cli-wikia) + control (cli-enforcement) + parallel execution (cli-fleet).',
      'cli-fleet': 'Hardware-aware parallel Claude Code agent orchestration via shared filesystem mailboxes.',
      'starforge-cli': 'Verification CLI auditing AI-coding telemetry with kernel-enforced no-egress proof.',
      'sitemap-mcp': 'MCP server providing website structural awareness without HTML token explosion.',
      'filelens-mcp': 'MCP server for single-call intelligent AST & structural file reading.',
      'starreckon': 'Local-only developer wrapped analyzer for disk logs (Claude Code, Cowork, Codex).',
      'verifier-mcp': 'Deterministic EU e-invoice compliance engine and paradox resolver (DevNetwork 2026).',
      'sorrell-engine-mcp': 'Browser-native neural OS & Tiny Model Swarm runtime (OpenAI WebMCP Challenge).',
      'package-telemetry': 'Cross-registry package telemetry engine for tracking PyPI and NPM package metrics, releases, and downloads.'
    }
  };
}

export function saveConfig(cfg, configPath) {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/**
 * Compute metrics across PyPI and NPM asynchronously.
 * `fetcher` is injectable so tests can stub the network layer.
 */
export async function computeMetrics(config, cachedData = {}, fetcher = fetchJson, options = {}) {
  const wantRuns = options.wantRuns === true;
  // Support both "pip" / "pypi" and "npm" / "npx" keys in config JSON
  const pypiList = config.pip || config.pypi || [];
  const npmList = config.npm || config.npx || [];
  const descriptions = config.descriptions || {};

  const cachedPypi = {};
  for (const p of cachedData.pypi || []) {
    if (p && p.package) cachedPypi[p.package] = p;
  }
  const cachedNpm = {};
  for (const p of cachedData.npm || []) {
    if (p && p.package) cachedNpm[p.package] = p;
  }

  const pypiPromises = pypiList.map(pkg => getPyPIStats(pkg, cachedPypi[pkg], descriptions[pkg], fetcher));
  const npmPromises = npmList.map(pkg => getNPMStats(pkg, cachedNpm[pkg], descriptions[pkg], fetcher, wantRuns));

  const resultsPypi = await Promise.all(pypiPromises);
  const resultsNpm = await Promise.all(npmPromises);

  const summaryPypi = calcGroup(resultsPypi);
  const summaryNpm = calcGroup(resultsNpm);
  const summaryAll = calcGroup([...resultsPypi, ...resultsNpm]);

  return {
    timestamp: new Date().toISOString(),
    pypi: resultsPypi,
    npm: resultsNpm,
    summary: {
      pypi: summaryPypi,
      npm: summaryNpm,
      all: summaryAll
    }
  };
}

/**
 * Word wrap helper for clean terminal tables
 */
function wordWrap(str, width) {
  if (!str) return [''];
  const words = str.split(/\s+/);
  const lines = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/**
 * Render terminal table matching package-stats styling
 */
export function renderTable(data, { detailed = false, runs = false, configPath = '', outputPath = '' } = {}) {
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[36m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const MAGENTA = '\x1b[35m';
  const RESET = '\x1b[0m';
  const DIM = '\x1b[2m';

  const headers = ['Type', 'Package', 'First Rel.', 'First Date', 'Current', 'Updated', 'Days Live', 'Last Day', 'Today', 'DL / Month', 'Lifetime DL'];
  const widths = [6, 17, 10, 11, 10, 11, 10, 10, 8, 12, 13];
  if (runs) {
    headers.push('Runs 30d');
    widths.push(10);
  }
  const bannerWidth = widths.reduce((a, b) => a + b, 0) + 3 * (widths.length - 1); // 148
  const border = '='.repeat(bannerWidth);
  const sepLine = '─'.repeat(bannerWidth);

  function formatRow(cols, colors = [], isBold = false) {
    const res = [];
    for (let i = 0; i < cols.length; i++) {
      const val = String(cols[i]);
      const w = widths[i];
      const formatted = i >= 6 ? val.padStart(w) : val.padEnd(w);
      const c = colors[i] || '';
      const b = isBold ? BOLD : '';
      res.push(`${b}${c}${formatted}${RESET}`);
    }
    return res.join(' │ ');
  }

  function centerText(txt, width) {
    const space = Math.max(0, width - txt.length);
    const padL = Math.floor(space / 2);
    const padR = space - padL;
    return ' '.repeat(padL) + txt + ' '.repeat(padR);
  }

  let out = '';
  out += `\n${BOLD}${CYAN}${border}${RESET}\n`;
  out += `${BOLD}${centerText('ALEXANDER SORRELL — PACKAGE METRICS & TELEMETRY', bannerWidth)}${RESET}\n`;
  out += `${BOLD}${CYAN}${border}${RESET}\n`;

  out += `${BOLD}${formatRow(headers)}${RESET}\n`;
  out += `${DIM}${sepLine}${RESET}\n`;

  const runsCell = (r) => {
    if (r.runs_30d == null) return 'n/a';
    return r.runs_30d.toLocaleString() + (r.runs_stale ? ' ~' : '');
  };

  // PyPI Rows
  for (const r of data.pypi || []) {
    const curVal = r.downloads_current_day || 0;
    const lastVal = r.downloads_last_day ?? r.downloads_per_day ?? 0;
    const cols = [
      'pip',
      r.package + (r.downloads_stale ? ' ~' : ''),
      r.first_version,
      r.first_date,
      r.current_version,
      r.current_date,
      `${r.days_live}d`,
      lastVal.toLocaleString(),
      curVal.toLocaleString(),
      r.downloads_per_month.toLocaleString(),
      r.downloads_lifetime.toLocaleString()
    ];
    const curColor = curVal === 0 ? DIM : GREEN;
    const colors = [YELLOW, CYAN, DIM, DIM, GREEN, DIM, YELLOW, GREEN, curColor, GREEN, BOLD + GREEN];
    if (runs) {
      cols.push(runsCell(r));
      colors.push(DIM);
    }
    out += `${formatRow(cols, colors)}\n`;
  }

  out += `${DIM}${sepLine}${RESET}\n`;

  // NPM Rows
  for (const r of data.npm || []) {
    const curVal = r.downloads_current_day || 0;
    const lastVal = r.downloads_last_day ?? r.downloads_per_day ?? 0;
    const cols = [
      'npx',
      r.package + (r.downloads_stale ? ' ~' : ''),
      r.first_version,
      r.first_date,
      r.current_version,
      r.current_date,
      `${r.days_live}d`,
      lastVal.toLocaleString(),
      curVal.toLocaleString(),
      r.downloads_per_month.toLocaleString(),
      r.downloads_lifetime.toLocaleString()
    ];
    const curColor = curVal === 0 ? DIM : GREEN;
    const colors = [MAGENTA, CYAN, DIM, DIM, GREEN, DIM, YELLOW, GREEN, curColor, GREEN, BOLD + GREEN];
    if (runs) {
      cols.push(runsCell(r));
      colors.push(CYAN);
    }
    out += `${formatRow(cols, colors)}\n`;
  }

  // Summary Table
  out += `${BOLD}${CYAN}${border}${RESET}\n`;
  out += `${BOLD}${centerText('AVERAGES & SUMMARY', bannerWidth)}${RESET}\n`;
  out += `${BOLD}${CYAN}${border}${RESET}\n`;

  const pSum = data.summary.pypi;
  const nSum = data.summary.npm;
  const aSum = data.summary.all;

  const sumHeaders = ['Category', 'Packages', 'Avg Days Live', 'Avg Last Day', 'Avg Today', 'Avg DL / Month', 'Avg Lifetime / Pkg', 'Total Lifetime DL'];
  const sumWidths = [16, 10, 14, 14, 12, 16, 20, 25];

  function formatSumRow(cols, colors = [], isBold = false) {
    const res = [];
    for (let i = 0; i < cols.length; i++) {
      const val = String(cols[i]);
      const w = sumWidths[i];
      const formatted = i >= 1 ? val.padStart(w) : val.padEnd(w);
      const c = colors[i] || '';
      const b = isBold ? BOLD : '';
      res.push(`${b}${c}${formatted}${RESET}`);
    }
    return res.join(' │ ');
  }

  const sumSep = '─'.repeat(sumWidths.reduce((a, b) => a + b, 0) + 3 * (sumWidths.length - 1));
  out += `${BOLD}${formatSumRow(sumHeaders)}${RESET}\n`;
  out += `${DIM}${sumSep}${RESET}\n`;

  const pLast = pSum.avg_last_day ?? pSum.avg_day ?? 0;
  const pCur = pSum.avg_current_day ?? 0;
  out += `${formatSumRow([
    'PyPI (pip)',
    `${pSum.count} pkgs`,
    `${pSum.avg_days_live}d`,
    `${pLast.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / day`,
    `${pCur.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / day`,
    `${pSum.avg_month.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / mo`,
    `${pSum.avg_lifetime.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / pkg`,
    pSum.total_lifetime.toLocaleString()
  ], [YELLOW, DIM, YELLOW, GREEN, pCur === 0 ? DIM : GREEN, GREEN, CYAN, BOLD + GREEN])}\n`;

  const nLast = nSum.avg_last_day ?? nSum.avg_day ?? 0;
  const nCur = nSum.avg_current_day ?? 0;
  out += `${formatSumRow([
    'NPM (npx)',
    `${nSum.count} pkgs`,
    `${nSum.avg_days_live}d`,
    `${nLast.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / day`,
    `${nCur.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / day`,
    `${nSum.avg_month.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / mo`,
    `${nSum.avg_lifetime.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / pkg`,
    nSum.total_lifetime.toLocaleString()
  ], [MAGENTA, DIM, YELLOW, GREEN, nCur === 0 ? DIM : GREEN, GREEN, CYAN, BOLD + GREEN])}\n`;

  out += `${DIM}${sumSep}${RESET}\n`;

  const aLast = aSum.avg_last_day ?? aSum.avg_day ?? 0;
  const aCur = aSum.avg_current_day ?? 0;
  out += `${formatSumRow([
    'ALL ECOSYSTEM',
    `${aSum.count} pkgs`,
    `${aSum.avg_days_live}d`,
    `${aLast.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / day`,
    `${aCur.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / day`,
    `${aSum.avg_month.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / mo`,
    `${aSum.avg_lifetime.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / pkg`,
    aSum.total_lifetime.toLocaleString()
  ], [BOLD + CYAN, BOLD, BOLD + YELLOW, BOLD + GREEN, aCur === 0 ? BOLD + DIM : BOLD + GREEN, BOLD + GREEN, BOLD + CYAN, BOLD + GREEN], true)}\n`;

  out += `${BOLD}${CYAN}${border}${RESET}\n`;

  // Detailed Second Table: What They Do
  if (detailed) {
    out += `\n${BOLD}${CYAN}${border}${RESET}\n`;
    out += `${BOLD}${centerText('PROGRAM DIRECTORY & WHAT THEY DO', bannerWidth)}${RESET}\n`;
    out += `${BOLD}${CYAN}${border}${RESET}\n`;

    const allRows = [];
    for (const r of data.pypi || []) {
      allRows.push(['pip', r.package, r.description || '(No description provided in config file)']);
    }
    for (const r of data.npm || []) {
      allRows.push(['npx', r.package, r.description || '(No description provided in config file)']);
    }

    const maxPkgLen = Math.max(19, ...allRows.map(r => r[1].length));
    const pkgWidth = maxPkgLen;
    const descWidth = Math.max(60, bannerWidth - 6 - 3 - pkgWidth - 3);

    out += `${BOLD}${'Type'.padEnd(6)} │ ${'Package'.padEnd(pkgWidth)} │ What It Does / Architecture${RESET}\n`;
    out += `${DIM}${sepLine}${RESET}\n`;

    let prevType = null;
    for (const [rType, pkg, desc] of allRows) {
      if (prevType && prevType !== rType) {
        out += `${DIM}${sepLine}${RESET}\n`;
      }
      prevType = rType;

      const tColor = rType === 'pip' ? YELLOW : MAGENTA;
      const pColor = CYAN;
      const lines = wordWrap(desc, descWidth);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let tCol, pCol;
        if (i === 0) {
          tCol = `${tColor}${rType.padEnd(6)}${RESET}`;
          pCol = `${pColor}${pkg.padEnd(pkgWidth)}${RESET}`;
        } else {
          tCol = ' '.repeat(6);
          pCol = ' '.repeat(pkgWidth);
        }
        out += `${tCol} │ ${pCol} │ ${line}\n`;
      }
    }
    out += `${BOLD}${CYAN}${border}${RESET}\n`;
  }

  // Stale notices
  const stale = [...(data.pypi || []), ...(data.npm || [])].filter(r => r.downloads_stale);
  if (stale.length > 0) {
    const names = stale.map(r => r.package).join(', ');
    out += `${YELLOW}  ~ Cached download numbers (live API unavailable): ${names}${RESET}\n`;
  }
  const runsStale = (data.npm || []).filter(r => r.runs_stale);
  if (runs && runsStale.length > 0) {
    const names = runsStale.map(r => r.package).join(', ');
    out += `${YELLOW}  ~ Cached runs numbers (jsDelivr unavailable): ${names}${RESET}\n`;
  }
  if (runs) {
    out += `${DIM}  Runs 30d = jsDelivr CDN file serves, trailing 30 days (n/a: no runs source for PyPI)${RESET}\n`;
  }

  const modeHint = !detailed ? '  •  Detailed mode: --detailed (or -d)' : '';
  const runsHint = !runs ? '  •  Runs column: --runs' : '';
  out += `${DIM}Config: ${configPath || 'packages.json'}${outputPath ? '  •  Output: ' + outputPath : ''}${modeHint}${runsHint}${RESET}\n\n`;

  return out;
}
