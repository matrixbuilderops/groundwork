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
 * Fetch pip download stats from pepy.tech — fallback when pypistats is down.
 * Same underlying PyPI logs, but mirrors INCLUDED and a shorter window, so
 * this is strictly second choice: live but inflated. Returns null on any
 * error or unexpected shape; callers fall through to cache.
 */
export async function getPepyStats(pkgName, fetcher = fetchJson) {
  const url = `https://pepy.tech/api/v2/projects/${pkgName}`;
  const data = await fetcher(url, 3, 100);
  if (!data || data._error || typeof data !== 'object' ||
      !data.downloads || typeof data.downloads !== 'object') {
    return null;
  }
  const byDate = {};
  for (const [dt, versions] of Object.entries(data.downloads)) {
    byDate[dt] = Object.values(versions || {}).reduce((s, n) => s + (n || 0), 0);
  }
  const sortedDates = Object.keys(byDate).sort();
  if (sortedDates.length === 0) return null;
  const todayStr = new Date().toISOString().slice(0, 10);
  const pastDates = sortedDates.filter(dt => dt < todayStr);
  const lastDate = pastDates.length > 0 ? pastDates[pastDates.length - 1] : sortedDates[sortedDates.length - 1];
  return {
    lifetime: typeof data.total_downloads === 'number'
      ? data.total_downloads
      : Object.values(byDate).reduce((s, v) => s + v, 0),
    perMonth: sortedDates.slice(-30).reduce((s, dt) => s + byDate[dt], 0),
    lastDay: byDate[lastDate] || 0,
    lastDayDate: lastDate,
    today: byDate[todayStr] || 0
  };
}

/**
 * Fetch PyPI stats and metadata.
 * Headlines count EVERYTHING (pypistats `with_mirrors`) by default — this is
 * a tracker, and trackers do not silently discard traffic. `--real-only`
 * switches headlines to `without_mirrors`; the `*_real` fields carry the
 * mirror-excluded series in both modes.
 * Source chain: pypistats -> pepy.tech fallback (mirrors included) -> cache.
 */
export async function getPyPIStats(pkgName, cachedPkg = null, configuredDesc = '', fetcher = fetchJson, realOnly = false) {
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
  let lifetimeReal = 0;
  let perMonthReal = 0;
  let lastDayReal = 0;
  let todayReal = 0;
  let lifetimeWithMirrors = 0;
  let perMonthWithMirrors = 0;
  let lastDayWithMirrors = 0;
  let todayWithMirrors = 0;
  const todayStr = new Date().toISOString().slice(0, 10);
  const daysActive = firstDate !== 'N/A' ? calculateDaysBetween(firstDate) : 1;

  if (!statsData._error && Array.isArray(statsData.data)) {
    const dataList = statsData.data;
    if (dataList.length > 0) {
      const byDateReal = {};
      const byDateFull = {};
      for (const d of dataList) {
        const dt = d.date || '';
        if (d.category === 'without_mirrors') {
          byDateReal[dt] = d.downloads || 0;
        } else if (d.category === 'with_mirrors') {
          byDateFull[dt] = d.downloads || 0;
        }
      }
      const headline = realOnly ? byDateReal : byDateFull;
      const sortedDates = [...new Set([...Object.keys(byDateReal), ...Object.keys(byDateFull)])].sort();
      const sum = (series) => Object.values(series).reduce((s, v) => s + v, 0);
      const last30 = sortedDates.slice(-30);
      const last30sum = (series) => last30.reduce((s, dt) => s + (series[dt] || 0), 0);
      lifetime = sum(headline);
      perMonth = last30sum(headline);
      lifetimeReal = sum(byDateReal);
      perMonthReal = last30sum(byDateReal);
      lifetimeWithMirrors = sum(byDateFull);
      perMonthWithMirrors = last30sum(byDateFull);

      todayDl = headline[todayStr] || 0;
      todayReal = byDateReal[todayStr] || 0;
      todayWithMirrors = byDateFull[todayStr] || 0;

      // Last finalized completed day (strictly before today)
      const pastDates = sortedDates.filter(dt => dt < todayStr);
      if (pastDates.length > 0) {
        lastDayDate = pastDates[pastDates.length - 1];
      } else if (sortedDates.length > 0) {
        lastDayDate = sortedDates[sortedDates.length - 1];
      }
      if (lastDayDate !== 'N/A') {
        lastDayDl = headline[lastDayDate] || 0;
        lastDayReal = byDateReal[lastDayDate] || 0;
        lastDayWithMirrors = byDateFull[lastDayDate] || 0;
      }
    }
  }

  const dlError = statsData._error || null;
  let stale = false;
  let dlSource = 'pypistats';
  // pepy.tech reads the same logs mirrors-included, so it backs the default
  // headlines only — never a real-only view (it cannot split mirrors out).
  if (!realOnly && lifetime === 0 && (statsData._error || !Array.isArray(statsData.data))) {
    const pepy = await getPepyStats(pkgName, fetcher);
    if (pepy && pepy.lifetime > 0) {
      lifetime = pepy.lifetime;
      perMonth = pepy.perMonth;
      lastDayDl = pepy.lastDay;
      lastDayDate = pepy.lastDayDate;
      todayDl = pepy.today;
      lifetimeWithMirrors = pepy.lifetime;
      perMonthWithMirrors = pepy.perMonth;
      lastDayWithMirrors = pepy.lastDay;
      todayWithMirrors = pepy.today;
      dlSource = 'pepy-fallback';
    }
  }
  if (lifetime === 0 && cachedPkg &&
      ((cachedPkg.downloads_lifetime || 0) > 0 ||
       (cachedPkg.downloads_lifetime_with_mirrors || 0) > 0 ||
       (cachedPkg.downloads_lifetime_real || 0) > 0)) {
    // Pre-flip caches (no marker) hold real-only headlines + with_mirrors
    // alongside; resolve each field to this run's headline contract.
    const cachedIsReal = cachedPkg.headlines_real_only !== false;
    if (realOnly) {
      lifetime = cachedIsReal ? (cachedPkg.downloads_lifetime || 0) : (cachedPkg.downloads_lifetime_real || 0);
      perMonth = cachedIsReal ? (cachedPkg.downloads_per_month || 0) : (cachedPkg.downloads_per_month_real || 0);
      lastDayDl = cachedIsReal ? (cachedPkg.downloads_last_day ?? cachedPkg.downloads_per_day ?? 0) : (cachedPkg.downloads_last_day_real || 0);
      todayDl = cachedIsReal ? (cachedPkg.downloads_current_day || 0) : (cachedPkg.downloads_current_day_real || 0);
    } else {
      lifetime = cachedIsReal ? (cachedPkg.downloads_lifetime_with_mirrors || cachedPkg.downloads_lifetime || 0) : (cachedPkg.downloads_lifetime || 0);
      perMonth = cachedIsReal ? (cachedPkg.downloads_per_month_with_mirrors || cachedPkg.downloads_per_month || 0) : (cachedPkg.downloads_per_month || 0);
      lastDayDl = cachedIsReal ? (cachedPkg.downloads_last_day_with_mirrors || cachedPkg.downloads_last_day || cachedPkg.downloads_per_day || 0) : (cachedPkg.downloads_last_day || cachedPkg.downloads_per_day || 0);
      todayDl = cachedIsReal ? (cachedPkg.downloads_current_day_with_mirrors || cachedPkg.downloads_current_day || 0) : (cachedPkg.downloads_current_day || 0);
    }
    lastDayDate = cachedPkg.downloads_last_day_date || 'N/A';
    lifetimeReal = cachedIsReal ? (cachedPkg.downloads_lifetime || 0) : (cachedPkg.downloads_lifetime_real || 0);
    perMonthReal = cachedIsReal ? (cachedPkg.downloads_per_month || 0) : (cachedPkg.downloads_per_month_real || 0);
    lastDayReal = cachedIsReal ? (cachedPkg.downloads_last_day ?? cachedPkg.downloads_per_day ?? 0) : (cachedPkg.downloads_last_day_real || 0);
    todayReal = cachedIsReal ? (cachedPkg.downloads_current_day || 0) : (cachedPkg.downloads_current_day_real || 0);
    lifetimeWithMirrors = cachedPkg.downloads_lifetime_with_mirrors || (!cachedIsReal ? (cachedPkg.downloads_lifetime || 0) : 0);
    perMonthWithMirrors = cachedPkg.downloads_per_month_with_mirrors || (!cachedIsReal ? (cachedPkg.downloads_per_month || 0) : 0);
    lastDayWithMirrors = cachedPkg.downloads_last_day_with_mirrors || (!cachedIsReal ? lastDayDl : 0);
    todayWithMirrors = cachedPkg.downloads_current_day_with_mirrors || (!cachedIsReal ? todayDl : 0);
    stale = true;
    dlSource = 'cache';
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
    downloads_lifetime_real: lifetimeReal,
    downloads_per_month_real: perMonthReal,
    downloads_last_day_real: lastDayReal,
    downloads_current_day_real: todayReal,
    headlines_real_only: realOnly,
    downloads_stale: stale,
    downloads_source: dlSource,
    downloads_error: dlError,
    meta_error: metaError,
    // PyPI publishes no execution counts and has no jsDelivr equivalent:
    // runs are honestly null, rendered as n/a, never zero-filled.
    runs_30d: null,
    runs_last_day: null,
    runs_last_day_date: null,
    runs_today: null,
    runs_prev_30d: null,
    runs_rank: null,
    runs_rank_prev: null,
    runs_window: null,
    runs_stale: false,
    runs_error: null,
    description: desc,
    url: `https://pypi.org/project/${pkgName}/`
  };
}

/**
 * Fetch jsDelivr CDN hits as the "runs" proxy for an npm package. npm and
 * PyPI publish no execution counts, so runs = CDN file serves. One call
 * yields every runs field: trailing-30d total, the daily map (source of
 * last-day + today), the prior-period total, and the CDN rank pair.
 * jsDelivr data lags ~1-2 days, so runs_today is usually null (rendered
 * n/a) — never backfilled. There is no lifetime-runs source: jsDelivr
 * retains 30 days only, so lifetime runs stay honestly null.
 */
export async function getJsdelivrRuns(pkgName, cachedPkg = null, fetcher = fetchJson) {
  const url = `https://data.jsdelivr.com/v1/stats/packages/npm/${pkgName}`;
  const data = await fetcher(url, 3, 50);
  if (!data._error && data.hits && typeof data.hits === 'object') {
    const dayMap = data.hits.dates || {};
    const dates = Object.keys(dayMap).sort();
    const total = typeof data.hits.total === 'number'
      ? data.hits.total
      : Object.values(dayMap).reduce((s, n) => s + (n || 0), 0);
    const lastDate = dates.length > 0 ? dates[dates.length - 1] : null;
    const todayKey = new Date().toISOString().slice(0, 10);
    const prev = (data.hits.prev && typeof data.hits.prev === 'object') ? data.hits.prev : {};
    return {
      runs_30d: total,
      runs_last_day: lastDate ? (dayMap[lastDate] ?? 0) : 0,
      runs_last_day_date: lastDate,
      runs_today: Object.hasOwn(dayMap, todayKey) ? (dayMap[todayKey] ?? 0) : null,
      runs_prev_30d: typeof prev.total === 'number' ? prev.total : null,
      runs_rank: typeof data.hits.rank === 'number' ? data.hits.rank : null,
      runs_rank_prev: typeof prev.rank === 'number' ? prev.rank : null,
      runs_window: dates.length > 0 ? `${dates[0]}..${dates[dates.length - 1]}` : 'N/A',
      runs_stale: false,
      runs_error: null
    };
  }
  if (cachedPkg && (cachedPkg.runs_30d || 0) > 0) {
    return {
      runs_30d: cachedPkg.runs_30d || 0,
      runs_last_day: cachedPkg.runs_last_day ?? null,
      runs_last_day_date: cachedPkg.runs_last_day_date || null,
      runs_today: cachedPkg.runs_today ?? null,
      runs_prev_30d: cachedPkg.runs_prev_30d ?? null,
      runs_rank: cachedPkg.runs_rank ?? null,
      runs_rank_prev: cachedPkg.runs_rank_prev ?? null,
      runs_window: cachedPkg.runs_window || 'N/A',
      runs_stale: true,
      runs_error: data._error || null
    };
  }
  return {
    runs_30d: 0,
    runs_last_day: null,
    runs_last_day_date: null,
    runs_today: null,
    runs_prev_30d: null,
    runs_rank: null,
    runs_rank_prev: null,
    runs_window: 'N/A',
    runs_stale: false,
    runs_error: data._error || null
  };
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
  let runs = {
    runs_30d: null, runs_last_day: null, runs_last_day_date: null,
    runs_today: null, runs_prev_30d: null, runs_rank: null,
    runs_rank_prev: null, runs_window: null, runs_stale: false, runs_error: null
  };
  if (wantRuns) {
    runs = await getJsdelivrRuns(pkgName, cachedPkg, fetcher);
  }

  return {
    registry: 'NPM (npx)',
    package: pkgName,
    runs_30d: runs.runs_30d,
    runs_last_day: runs.runs_last_day,
    runs_last_day_date: runs.runs_last_day_date,
    runs_today: runs.runs_today,
    runs_prev_30d: runs.runs_prev_30d,
    runs_rank: runs.runs_rank,
    runs_rank_prev: runs.runs_rank_prev,
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
    downloads_source: stale ? 'cache' : 'npm-api',
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
  const realOnly = options.realOnly === true;
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

  const pypiPromises = pypiList.map(pkg => getPyPIStats(pkg, cachedPypi[pkg], descriptions[pkg], fetcher, realOnly));
  const npmPromises = npmList.map(pkg => getNPMStats(pkg, cachedNpm[pkg], descriptions[pkg], fetcher, wantRuns));

  const resultsPypi = await Promise.all(pypiPromises);
  const resultsNpm = await Promise.all(npmPromises);

  const summaryPypi = calcGroup(resultsPypi);
  const summaryNpm = calcGroup(resultsNpm);
  const summaryAll = calcGroup([...resultsPypi, ...resultsNpm]);

  return {
    timestamp: new Date().toISOString(),
    mirrors_included: !realOnly,
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
 * Append one lean snapshot line to the history JSONL. Refuses to record when
 * any row is stale (replaying cached numbers would fake plateaus in growth
 * charts) and prunes past `cap` snapshots. Never throws — returns success.
 */
export function appendHistory(data, historyPath, cap = 2000) {
  try {
    const rows = [...(data.pypi || []), ...(data.npm || [])];
    if (rows.some(r => r.downloads_stale)) return false;
    const packages = {};
    for (const r of rows) {
      packages[r.package] = {
        life: r.downloads_lifetime || 0,
        month: r.downloads_per_month || 0,
        last: r.downloads_last_day ?? r.downloads_per_day ?? 0,
        today: r.downloads_current_day || 0,
        runs30: r.runs_30d ?? null,
        rank: r.runs_rank ?? null
      };
    }
    const line = JSON.stringify({
      ts: data.timestamp || new Date().toISOString(),
      mirrors_included: data.mirrors_included !== false,
      sources_mixed: (data.pypi || []).some(r => r.downloads_source === 'pepy-fallback'),
      packages,
      totals: {
        life: data.summary?.all?.total_lifetime || 0,
        month: data.summary?.all?.total_month || 0
      }
    }) + '\n';
    fs.appendFileSync(historyPath, line, 'utf8');
    const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(l => l.trim() !== '');
    if (lines.length > cap) {
      fs.writeFileSync(historyPath, lines.slice(-cap).join('\n') + '\n', 'utf8');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Load history snapshots, skipping corrupt lines. Missing file = [].
 */
export function loadHistory(historyPath) {
  try {
    if (!fs.existsSync(historyPath)) return [];
    const out = [];
    for (const line of fs.readFileSync(historyPath, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const h = JSON.parse(line);
        if (h && typeof h.ts === 'string' && h.packages && typeof h.packages === 'object') {
          out.push(h);
        }
      } catch {
        // skip corrupt line
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Lifetime deltas vs the snapshot nearest each window boundary, filtered to
 * the current mirror mode (never compare across modes). Ties prefer the more
 * recent snapshot (conservative delta, fresher reference).
 */
export function computeTrend(history, liveMap, { realOnly = false, now = Date.now() } = {}) {
  const wantMirrors = !realOnly;
  const matching = (history || []).filter(h => (h.mirrors_included !== false) === wantMirrors);
  const refFor = (days) => {
    if (matching.length === 0) return null;
    const target = now - days * 86400000;
    let best = matching[0];
    let bestGap = Math.abs(Date.parse(best.ts) - target);
    for (const h of matching) {
      const gap = Math.abs(Date.parse(h.ts) - target);
      if (gap < bestGap || (gap === bestGap && Date.parse(h.ts) > Date.parse(best.ts))) {
        best = h;
        bestGap = gap;
      }
    }
    return best;
  };
  const ref7 = refFor(7);
  const ref30 = refFor(30);
  const rows = Object.entries(liveMap).map(([pkg, life]) => ({
    package: pkg,
    now: life,
    d7: ref7 ? life - (ref7.packages[pkg]?.life ?? 0) : null,
    d30: ref30 ? life - (ref30.packages[pkg]?.life ?? 0) : null
  }));
  return {
    rows,
    count: matching.length,
    oldestTs: matching.length > 0 ? matching[0].ts : null
  };
}

/**
 * Render the growth table: lifetime now + 7/30-day deltas.
 */
export function renderTrend(data, history, { realOnly = false } = {}) {
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[36m';
  const GREEN = '\x1b[32m';
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';
  const liveRows = [...(data.pypi || []), ...(data.npm || [])];
  const liveMap = {};
  for (const r of liveRows) liveMap[r.package] = r.downloads_lifetime || 0;
  const trend = computeTrend(history, liveMap, { realOnly });
  if (trend.count === 0) {
    return `\n${DIM}  No history yet — run without --no-save to start recording snapshots.${RESET}\n\n`;
  }
  const fmtDelta = (d) => {
    if (d == null) return 'n/a';
    if (d > 0) return `${GREEN}+${d.toLocaleString()}${RESET}`;
    if (d < 0) return `${DIM}${d.toLocaleString()}${RESET}`;
    return `${DIM}0${RESET}`;
  };
  const stripLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const headers = ['Package', 'Lifetime', '7d Δ', '30d Δ'];
  const widths = [18, 12, 10, 10];
  const W = widths.reduce((a, b) => a + b, 0) + 3 * (widths.length - 1);
  const border = '='.repeat(W);
  const sep = '─'.repeat(W);
  const padCell = (text, w, right) => {
    const raw = stripLen(text);
    const pad = ' '.repeat(Math.max(0, w - raw));
    return right ? pad + text : text + pad;
  };
  let out = '';
  out += `\n${BOLD}${CYAN}${border}${RESET}\n`;
  out += `${BOLD}${'GROWTH TREND — LIFETIME DELTAS'.padStart((W + 29) / 2).padEnd(W)}${RESET}\n`;
  out += `${BOLD}${CYAN}${border}${RESET}\n`;
  out += `${BOLD}${padCell(headers[0], widths[0])} │ ${padCell(headers[1], widths[1], true)} │ ${padCell(headers[2], widths[2], true)} │ ${padCell(headers[3], widths[3], true)}${RESET}\n`;
  out += `${DIM}${sep}${RESET}\n`;
  for (const t of trend.rows) {
    out += `${CYAN}${padCell(t.package, widths[0])}${RESET} │ ${padCell(t.now.toLocaleString(), widths[1], true)} │ ${padCell(fmtDelta(t.d7), widths[2], true)} │ ${padCell(fmtDelta(t.d30), widths[3], true)}\n`;
  }
  out += `${DIM}${sep}${RESET}\n`;
  const oldest = trend.oldestTs ? trend.oldestTs.slice(0, 10) : 'N/A';
  out += `${DIM}  oldest snapshot: ${oldest} │ snapshots: ${trend.count}${realOnly ? ' │ real-only' : ''}${RESET}\n\n`;
  return out;
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
const MAIN_COLS = [
  { id: 'type', header: 'Type', width: 6, align: 'l', drop: 0 },
  { id: 'pkg', header: 'Package', width: 17, align: 'l', drop: 0, shrinkMin: 12 },
  { id: 'firstv', header: 'First Rel.', width: 10, align: 'l', drop: 2 },
  { id: 'firstd', header: 'First Date', width: 11, align: 'l', drop: 1 },
  { id: 'current', header: 'Current', width: 10, align: 'l', drop: 5 },
  { id: 'updated', header: 'Updated', width: 11, align: 'l', drop: 4 },
  { id: 'dayslive', header: 'Days Live', width: 10, align: 'r', drop: 3 },
  { id: 'lastday', header: 'Last Day', width: 10, align: 'r', drop: 0 },
  { id: 'rday', header: 'R-Day', width: 8, align: 'r', drop: 0, runsOnly: true },
  { id: 'today', header: 'Today', width: 8, align: 'r', drop: 0 },
  { id: 'rtoday', header: 'R-Today', width: 8, align: 'r', drop: 0, runsOnly: true },
  { id: 'month', header: 'DL / Month', width: 12, align: 'r', drop: 0 },
  { id: 'r30d', header: 'R-30d', width: 10, align: 'r', drop: 0, runsOnly: true },
  { id: 'life', header: 'Lifetime DL', width: 13, align: 'r', drop: 0 },
  { id: 'rlife', header: 'R-Life', width: 7, align: 'r', drop: 0, runsOnly: true },
  { id: 'rank', header: 'CDN Rank', width: 10, align: 'r', drop: 0, runsOnly: true }
];

/**
 * Choose visible main-table columns for a terminal width. Stat columns
 * (downloads + runs + rank) are never dropped: only the five metadata
 * columns shed, lowest priority first, then Package shrinks to 12 with an
 * ellipsis. width null/undefined = full table, no dropping.
 */
export function pickColumns({ runs = false, width = null } = {}) {
  let cols = MAIN_COLS.filter(c => runs || !c.runsOnly).map(c => ({ ...c }));
  const tableWidth = (cs) => cs.reduce((s, c) => s + c.width, 0) + 3 * (cs.length - 1);
  const dropped = [];
  if (width == null || tableWidth(cols) <= width) {
    return { cols, dropped, neededWidth: tableWidth(cols), fits: true };
  }
  const sheddable = cols.filter(c => c.drop > 0).sort((a, b) => a.drop - b.drop);
  for (const d of sheddable) {
    if (tableWidth(cols) <= width) break;
    cols = cols.filter(c => c !== d);
    dropped.push(d.header);
  }
  const pkg = cols.find(c => c.id === 'pkg');
  while (tableWidth(cols) > width && pkg.width > pkg.shrinkMin) pkg.width -= 1;
  const neededWidth = tableWidth(cols);
  return { cols, dropped, neededWidth, fits: neededWidth <= width };
}

/**
 * Decide the render width: --full and non-TTY output (pipes, redirects,
 * tests) always render the full table; a live terminal renders to its width.
 */
export function resolveRenderWidth({ full = false, columns = null, isTTY = false } = {}) {
  if (full || !isTTY) return null;
  return columns || 80;
}

export function renderTable(data, { detailed = false, runs = false, realOnly = false, configPath = '', outputPath = '', width = null } = {}) {
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[36m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const MAGENTA = '\x1b[35m';
  const RESET = '\x1b[0m';
  const DIM = '\x1b[2m';

  const layout = pickColumns({ runs, width });
  const cols = layout.cols;
  const headers = cols.map(c => c.header);
  const widths = cols.map(c => c.width);
  const bannerWidth = widths.reduce((a, b) => a + b, 0) + 3 * (widths.length - 1);
  const border = '='.repeat(bannerWidth);
  const sepLine = '─'.repeat(bannerWidth);

  function formatRow(values, colors = [], isBold = false) {
    const res = [];
    for (let i = 0; i < values.length; i++) {
      const val = String(values[i]);
      const w = widths[i];
      const formatted = cols[i].align === 'r' ? val.padStart(w) : val.padEnd(w);
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

  const runsVal = (r, field) => {
    if (r[field] == null) return 'n/a';
    return r[field].toLocaleString() + (r.runs_stale ? ' ~' : '');
  };
  const compactRank = (n) => {
    if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
    if (n >= 1e3) return `${Math.round(n / 100) / 10}k`;
    return `${n}`;
  };
  const rankCell = (r) => {
    if (r.runs_rank == null) return 'n/a';
    // Lower rank number = more hits, so a drop in number is an improvement.
    const trend = (r.runs_rank_prev == null || r.runs_rank === r.runs_rank_prev)
      ? ''
      : (r.runs_rank < r.runs_rank_prev ? ' ▲' : ' ▼');
    return compactRank(r.runs_rank) + trend + (r.runs_stale ? ' ~' : '');
  };

  const pkgW = cols.find(c => c.id === 'pkg').width;
  const fitPkg = (name) => (pkgW < 17 && name.length > pkgW) ? name.slice(0, pkgW - 1) + '…' : name;

  // id -> [value, color] for one data row; visible cols decide rendering.
  const rowCells = (r, typeName, typeColor, runsColor) => {
    const curVal = r.downloads_current_day || 0;
    const lastVal = r.downloads_last_day ?? r.downloads_per_day ?? 0;
    const curColor = curVal === 0 ? DIM : GREEN;
    return {
      type: [typeName, typeColor],
      pkg: [fitPkg(r.package + (r.downloads_stale ? ' ~' : '')), CYAN],
      firstv: [r.first_version, DIM],
      firstd: [r.first_date, DIM],
      current: [r.current_version, GREEN],
      updated: [r.current_date, DIM],
      dayslive: [`${r.days_live}d`, YELLOW],
      lastday: [lastVal.toLocaleString(), GREEN],
      rday: [runsVal(r, 'runs_last_day'), runsColor],
      today: [curVal.toLocaleString(), curColor],
      rtoday: [runsVal(r, 'runs_today'), runsColor],
      month: [r.downloads_per_month.toLocaleString(), GREEN],
      r30d: [runsVal(r, 'runs_30d'), runsColor],
      life: [r.downloads_lifetime.toLocaleString(), BOLD + GREEN],
      rlife: ['n/a', DIM],
      rank: [rankCell(r), runsColor]
    };
  };
  const emitRow = (r, typeName, typeColor, runsColor) => {
    const cells = rowCells(r, typeName, typeColor, runsColor);
    out += `${formatRow(cols.map(c => cells[c.id][0]), cols.map(c => cells[c.id][1]))}\n`;
  };

  // PyPI Rows
  for (const r of data.pypi || []) {
    emitRow(r, 'pip', YELLOW, DIM);
  }

  out += `${DIM}${sepLine}${RESET}\n`;

  // NPM Rows
  for (const r of data.npm || []) {
    emitRow(r, 'npx', MAGENTA, CYAN);
  }

  // Summary Table
  out += `${BOLD}${CYAN}${border}${RESET}\n`;
  out += `${BOLD}${centerText('AVERAGES & SUMMARY', bannerWidth)}${RESET}\n`;
  out += `${BOLD}${CYAN}${border}${RESET}\n`;

  const pSum = data.summary.pypi;
  const nSum = data.summary.npm;
  const aSum = data.summary.all;

  const compactSum = layout.dropped.length > 0;
  const sumHeaders = compactSum
    ? ['Category', 'Pkgs', 'Avg Days', 'Avg Day', 'Avg / Mo', 'Avg / Pkg', 'Total DL']
    : ['Category', 'Packages', 'Avg Days Live', 'Avg Last Day', 'Avg Today', 'Avg DL / Month', 'Avg Lifetime / Pkg', 'Total Lifetime DL'];
  const sumWidths = compactSum ? [8, 4, 8, 8, 10, 10, 12] : [16, 10, 14, 14, 12, 16, 20, 25];

  const oneDec = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // Full branch preserves legacy output exactly; compact drops suffixes, long
  // labels, and Avg Now (today's partial counts, near-zero by definition).
  const sumCells = (cat, s) => {
    const last = s.avg_last_day ?? s.avg_day ?? 0;
    const cur = s.avg_current_day ?? 0;
    if (compactSum) {
      return [cat.short, `${s.count}`, oneDec(s.avg_days_live), oneDec(last), oneDec(s.avg_month), oneDec(s.avg_lifetime), s.total_lifetime.toLocaleString()];
    }
    return [cat.full, `${s.count} pkgs`, `${s.avg_days_live}d`, `${oneDec(last)} / day`, `${oneDec(cur)} / day`, `${oneDec(s.avg_month)} / mo`, `${oneDec(s.avg_lifetime)} / pkg`, s.total_lifetime.toLocaleString()];
  };

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

  const sumColors = (arr) => compactSum ? arr.filter((_, i) => i !== 4) : arr;
  const pCur = pSum.avg_current_day ?? 0;
  out += `${formatSumRow(sumCells({ full: 'PyPI (pip)', short: 'pip' }, pSum), sumColors([YELLOW, DIM, YELLOW, GREEN, pCur === 0 ? DIM : GREEN, GREEN, CYAN, BOLD + GREEN]))}\n`;

  const nCur = nSum.avg_current_day ?? 0;
  out += `${formatSumRow(sumCells({ full: 'NPM (npx)', short: 'npx' }, nSum), sumColors([MAGENTA, DIM, YELLOW, GREEN, nCur === 0 ? DIM : GREEN, GREEN, CYAN, BOLD + GREEN]))}\n`;

  out += `${DIM}${sumSep}${RESET}\n`;

  const aCur = aSum.avg_current_day ?? 0;
  out += `${formatSumRow(sumCells({ full: 'ALL ECOSYSTEM', short: 'ALL' }, aSum), sumColors([BOLD + CYAN, BOLD, BOLD + YELLOW, BOLD + GREEN, aCur === 0 ? BOLD + DIM : BOLD + GREEN, BOLD + GREEN, BOLD + CYAN, BOLD + GREEN]), true)}\n`;

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
  if (realOnly) {
    out += `${DIM}  headlines exclude mirror sync traffic (--real-only); default counts everything${RESET}\n`;
  }
  const pepyRows = (data.pypi || []).filter(r => r.downloads_source === 'pepy-fallback');
  if (pepyRows.length > 0) {
    const names = pepyRows.map(r => r.package).join(', ');
    out += `${YELLOW}  ~ pepy.tech fallback (mirrors included, pypistats was down): ${names}${RESET}\n`;
  }
  const runsStale = (data.npm || []).filter(r => r.runs_stale);
  if (runs && runsStale.length > 0) {
    const names = runsStale.map(r => r.package).join(', ');
    out += `${YELLOW}  ~ Cached runs numbers (jsDelivr unavailable): ${names}${RESET}\n`;
  }
  if (runs) {
    const dayDates = [...(data.pypi || []), ...(data.npm || [])]
      .map(r => r.runs_last_day_date).filter(Boolean).sort();
    const rDay = dayDates.length > 0 ? dayDates[dayDates.length - 1] : 'N/A';
    out += `${DIM}  R-Day = jsDelivr serves on ${rDay} (feed lags ~1-2d) │ R-Today = serves today, if reported │ R-30d = trailing-30d serves${RESET}\n`;
    out += `${DIM}  R-Life = n/a: jsDelivr retains 30 days only, lifetime runs unknowable │ CDN Rank = rank by hits, ▲/▼ vs prior 30d │ n/a on pip: no runs source for PyPI${RESET}\n`;
  }

  if (layout.dropped.length > 0) {
    let hid = `${layout.dropped.length} cols: ${layout.dropped.join(', ')}`;
    if (width != null && hid.length + 42 > width) {
      hid = `${layout.dropped.length} cols (${layout.dropped[0]}, …)`;
    }
    out += `${DIM}  compact: hid ${hid} (widen terminal or --full)${RESET}\n`;
  }
  if (width != null && !layout.fits) {
    out += `${DIM}  table needs ${layout.neededWidth} cols, terminal is ${width} — widen to fit${RESET}\n`;
  }

  if (compactSum && width != null) {
    const parts = [`Config: ${configPath ? path.basename(configPath) : 'packages.json'}`];
    if (!detailed) parts.push('--detailed');
    if (!runs) parts.push('--runs');
    out += `${DIM}${parts.join('  •  ')}${RESET}\n\n`;
  } else {
    const modeHint = !detailed ? '  •  Detailed mode: --detailed (or -d)' : '';
    const runsHint = !runs ? '  •  Runs columns: --runs' : '';
    out += `${DIM}Config: ${configPath || 'packages.json'}${outputPath ? '  •  Output: ' + outputPath : ''}${modeHint}${runsHint}${RESET}\n\n`;
  }

  return out;
}
