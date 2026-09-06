import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_FILE = path.join(PACKAGE_ROOT, 'packages.json');

const HEADERS = {
  'User-Agent': 'PackageTelemetry/2.0 (+https://github.com/matrixbuilderops)'
};

/**
 * Fallback DNS-over-HTTPS resolver via Cloudflare (1.1.1.1) and Google (8.8.8.8).
 * Bypasses local ISP resolver failures (SERVFAIL / ENOTFOUND / Errno 8).
 */
async function dohResolve(hostname) {
  for (const resolver of ['1.1.1.1', '8.8.8.8']) {
    try {
      const url = `https://${resolver}/dns-query?name=${encodeURIComponent(hostname)}&type=A`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/dns-json', ...HEADERS },
        signal: AbortSignal.timeout(3000)
      });
      if (res.ok) {
        const json = await res.json();
        const answers = (json.Answer || []).filter(a => a.type === 1);
        if (answers.length > 0 && answers[0].data) {
          return answers[0].data;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Robust JSON fetcher with retry & DoH fallback.
 */
export async function fetchJson(url, maxRetries = 4, delayMs = 100) {
  if (delayMs > 0) {
    await new Promise(r => setTimeout(r, delayMs));
  }
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  let lastErr = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let targetUrl = url;
    const reqHeaders = { ...HEADERS };

    // If initial attempt hit a DNS error, try DoH direct IP resolution
    if (attempt > 0 && lastErr && (lastErr.code === 'ENOTFOUND' || lastErr.message?.includes('getaddrinfo'))) {
      const ip = await dohResolve(hostname);
      if (ip) {
        targetUrl = url.replace(`://${hostname}`, `://${ip}`);
        reqHeaders['Host'] = hostname;
      }
    }

    try {
      const res = await fetch(targetUrl, {
        headers: reqHeaders,
        signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) {
        return { _error: `HTTP ${res.status}: ${res.statusText}` };
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
  return { _error: lastErr ? lastErr.message : 'Unknown network failure' };
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
 * Fetch PyPI stats and metadata
 */
export async function getPyPIStats(pkgName, cachedPkg = null, configuredDesc = '') {
  const pypiUrl = `https://pypi.org/pypi/${pkgName}/json`;
  const pypiData = await fetchJson(pypiUrl, 3, 50);

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

  // Fetch daily downloads from pypistats API
  const statsUrl = `https://pypistats.org/api/packages/${pkgName}/overall`;
  const statsData = await fetchJson(statsUrl, 3, 100);

  let lifetime = 0;
  let perMonth = 0;
  let perDay = 0;
  const daysActive = firstDate !== 'N/A' ? calculateDaysBetween(firstDate) : 1;

  if (!statsData._error && Array.isArray(statsData.data)) {
    const dataList = statsData.data;
    let withMirrors = dataList.filter(d => d.category === 'with_mirrors');
    if (withMirrors.length === 0) withMirrors = dataList;
    withMirrors.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    if (withMirrors.length > 0) {
      lifetime = withMirrors.reduce((sum, d) => sum + (d.downloads || 0), 0);
      const last30 = withMirrors.slice(-30);
      perMonth = last30.reduce((sum, d) => sum + (d.downloads || 0), 0);
      perDay = daysActive > 0 ? Math.round((lifetime / daysActive) * 10) / 10 : 0;
    }
  }

  const dlError = statsData._error || null;
  let stale = false;
  if (lifetime === 0 && cachedPkg && (cachedPkg.downloads_lifetime || 0) > 0) {
    lifetime = cachedPkg.downloads_lifetime || 0;
    perMonth = cachedPkg.downloads_per_month || 0;
    perDay = daysActive > 0 ? Math.round((lifetime / daysActive) * 10) / 10 : (cachedPkg.downloads_per_day || 0);
    stale = true;
  }

  const desc = configuredDesc || apiDesc || (cachedPkg?.description) || '';

  return {
    registry: 'PyPI (pip)',
    package: pkgName,
    first_version: String(firstVer).startsWith('v') ? firstVer : `v${firstVer}`,
    first_date: firstDate,
    current_version: String(latestVer).startsWith('v') ? latestVer : `v${latestVer}`,
    current_date: latestDate,
    days_live: daysActive,
    total_releases: totalReleases,
    downloads_per_day: perDay,
    downloads_per_month: perMonth,
    downloads_lifetime: lifetime,
    downloads_stale: stale,
    downloads_error: dlError,
    description: desc,
    url: `https://pypi.org/project/${pkgName}/`
  };
}

/**
 * Fetch NPM stats and metadata
 */
export async function getNPMStats(pkgName, cachedPkg = null, configuredDesc = '') {
  const npmUrl = `https://registry.npmjs.org/${pkgName}`;
  const npmData = await fetchJson(npmUrl, 3, 50);

  let firstVer = 'N/A';
  let firstDate = 'N/A';
  let latestVer = 'N/A';
  let latestDate = 'N/A';
  let totalReleases = 0;
  let apiDesc = '';

  if (!npmData._error) {
    const timeMap = npmData.time || {};
    const versions = Object.keys(timeMap).filter(v => v !== 'created' && v !== 'modified');
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
  const dlData = await fetchJson(dlUrl, 3, 50);

  let lifetime = 0;
  let perMonth = 0;
  let perDay = 0;
  const daysActive = firstDate !== 'N/A' ? calculateDaysBetween(firstDate) : 1;

  if (!dlData._error && Array.isArray(dlData.downloads)) {
    const list = dlData.downloads;
    if (list.length > 0) {
      lifetime = list.reduce((sum, d) => sum + (d.downloads || 0), 0);
      const last30 = list.slice(-30);
      perMonth = last30.reduce((sum, d) => sum + (d.downloads || 0), 0);
      perDay = daysActive > 0 ? Math.round((lifetime / daysActive) * 10) / 10 : 0;
    }
  }

  const dlError = dlData._error || null;
  let stale = false;
  if (lifetime === 0 && cachedPkg && (cachedPkg.downloads_lifetime || 0) > 0) {
    lifetime = cachedPkg.downloads_lifetime || 0;
    perMonth = cachedPkg.downloads_per_month || 0;
    perDay = daysActive > 0 ? Math.round((lifetime / daysActive) * 10) / 10 : (cachedPkg.downloads_per_day || 0);
    stale = true;
  }

  const desc = configuredDesc || apiDesc || (cachedPkg?.description) || '';

  return {
    registry: 'NPM (npx)',
    package: pkgName,
    first_version: String(firstVer).startsWith('v') ? firstVer : `v${firstVer}`,
    first_date: firstDate,
    current_version: String(latestVer).startsWith('v') ? latestVer : `v${latestVer}`,
    current_date: latestDate,
    days_live: daysActive,
    total_releases: totalReleases,
    downloads_per_day: perDay,
    downloads_per_month: perMonth,
    downloads_lifetime: lifetime,
    downloads_stale: stale,
    downloads_error: dlError,
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
      total_day: 0,
      avg_lifetime: 0,
      avg_month: 0,
      avg_day: 0,
      avg_days_live: 0
    };
  }
  const totLife = items.reduce((s, i) => s + (i.downloads_lifetime || 0), 0);
  const totMonth = items.reduce((s, i) => s + (i.downloads_per_month || 0), 0);
  const totDay = items.reduce((s, i) => s + (i.downloads_per_day || 0), 0);
  const totDays = items.reduce((s, i) => s + (i.days_live || 0), 0);

  return {
    count: n,
    total_lifetime: totLife,
    total_month: totMonth,
    total_day: Math.round(totDay * 10) / 10,
    avg_lifetime: Math.round((totLife / n) * 10) / 10,
    avg_month: Math.round((totMonth / n) * 10) / 10,
    avg_day: Math.round((totDay / n) * 10) / 10,
    avg_days_live: Math.round((totDays / n) * 10) / 10
  };
}

/**
 * Resolve config from CLI option, cwd, user home, or package fallback.
 */
export function resolveConfigPath(customPath = null) {
  if (customPath && fs.existsSync(customPath)) {
    return path.resolve(customPath);
  }

  // 1. Current working directory
  const cwdPackages = path.join(process.cwd(), 'packages.json');
  if (fs.existsSync(cwdPackages)) return cwdPackages;

  const cwdPackagesConfig = path.join(process.cwd(), 'packages_config.json');
  if (fs.existsSync(cwdPackagesConfig)) return cwdPackagesConfig;

  // 2. User home directory ~/.config/pip-npx-stats/packages.json
  const userConfig = path.join(os.homedir(), '.config', 'pip-npx-stats', 'packages.json');
  if (fs.existsSync(userConfig)) return userConfig;

  // 3. Fallback to package bundled config
  if (fs.existsSync(DEFAULT_CONFIG_FILE)) return DEFAULT_CONFIG_FILE;

  return cwdPackages;
}

export function loadConfig(configPath) {
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch {}

  return {
    pip: ['cli-enforcement'],
    npx: ['filelens-mcp'],
    descriptions: {
      'cli-enforcement': 'Model-agnostic hook-level behavioral enforcement engine for AI coding agents.',
      'filelens-mcp': 'MCP server for single-call intelligent AST & structural file reading.'
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
 * Compute metrics across PyPI and NPM asynchronously
 */
export async function computeMetrics(config, cachedData = {}) {
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

  const pypiPromises = pypiList.map(pkg => getPyPIStats(pkg, cachedPypi[pkg], descriptions[pkg]));
  const npmPromises = npmList.map(pkg => getNPMStats(pkg, cachedNpm[pkg], descriptions[pkg]));

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
export function renderTable(data, { detailed = false, configPath = '', outputPath = '' } = {}) {
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[36m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const MAGENTA = '\x1b[35m';
  const RESET = '\x1b[0m';
  const DIM = '\x1b[2m';

  const headers = ['Type', 'Package', 'First Rel.', 'First Date', 'Current', 'Updated', 'Days Live', 'DL / Day', 'DL / Month', 'Lifetime DL'];
  const widths = [6, 17, 10, 11, 10, 11, 10, 10, 12, 13];
  const tableWidth = widths.reduce((a, b) => a + b, 0) + 3 * (widths.length - 1); // 127
  const border = '='.repeat(tableWidth);
  const sepLine = '─'.repeat(tableWidth);

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

  let out = '';
  out += `\n${BOLD}${CYAN}${border}${RESET}\n`;
  out += `                                   ${BOLD}ALEXANDER SORRELL — PACKAGE METRICS & TELEMETRY${RESET}\n`;
  out += `${BOLD}${CYAN}${border}${RESET}\n`;

  out += `${BOLD}${formatRow(headers)}${RESET}\n`;
  out += `${DIM}${sepLine}${RESET}\n`;

  // PyPI Rows
  for (const r of data.pypi || []) {
    const cols = [
      'pip',
      r.package + (r.downloads_stale ? ' ~' : ''),
      r.first_version,
      r.first_date,
      r.current_version,
      r.current_date,
      `${r.days_live}d`,
      r.downloads_per_day.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      r.downloads_per_month.toLocaleString(),
      r.downloads_lifetime.toLocaleString()
    ];
    const colors = [YELLOW, CYAN, DIM, DIM, GREEN, DIM, YELLOW, GREEN, GREEN, BOLD + GREEN];
    out += `${formatRow(cols, colors)}\n`;
  }

  out += `${DIM}${sepLine}${RESET}\n`;

  // NPM Rows
  for (const r of data.npm || []) {
    const cols = [
      'npx',
      r.package + (r.downloads_stale ? ' ~' : ''),
      r.first_version,
      r.first_date,
      r.current_version,
      r.current_date,
      `${r.days_live}d`,
      r.downloads_per_day.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      r.downloads_per_month.toLocaleString(),
      r.downloads_lifetime.toLocaleString()
    ];
    const colors = [MAGENTA, CYAN, DIM, DIM, GREEN, DIM, YELLOW, GREEN, GREEN, BOLD + GREEN];
    out += `${formatRow(cols, colors)}\n`;
  }

  // Summary Table
  out += `${BOLD}${CYAN}${border}${RESET}\n`;
  out += `${BOLD}                                              AVERAGES & SUMMARY${RESET}\n`;
  out += `${BOLD}${CYAN}${border}${RESET}\n`;

  const pSum = data.summary.pypi;
  const nSum = data.summary.npm;
  const aSum = data.summary.all;

  const sumHeaders = ['Category', 'Packages', 'Avg Days Live', 'Avg DL / Day', 'Avg DL / Month', 'Avg Lifetime / Pkg', 'Total Lifetime DL'];
  const sumWidths = [16, 10, 14, 14, 16, 20, 18];

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

  out += `${formatSumRow([
    'PyPI (pip)',
    `${pSum.count} pkgs`,
    `${pSum.avg_days_live}d`,
    `${pSum.avg_day.toLocaleString(undefined, { minimumFractionDigits: 1 })} / day`,
    `${pSum.avg_month.toLocaleString(undefined, { minimumFractionDigits: 1 })} / mo`,
    `${pSum.avg_lifetime.toLocaleString(undefined, { minimumFractionDigits: 1 })} / pkg`,
    pSum.total_lifetime.toLocaleString()
  ], [YELLOW, DIM, YELLOW, GREEN, GREEN, CYAN, BOLD + GREEN])}\n`;

  out += `${formatSumRow([
    'NPM (npx)',
    `${nSum.count} pkgs`,
    `${nSum.avg_days_live}d`,
    `${nSum.avg_day.toLocaleString(undefined, { minimumFractionDigits: 1 })} / day`,
    `${nSum.avg_month.toLocaleString(undefined, { minimumFractionDigits: 1 })} / mo`,
    `${nSum.avg_lifetime.toLocaleString(undefined, { minimumFractionDigits: 1 })} / pkg`,
    nSum.total_lifetime.toLocaleString()
  ], [MAGENTA, DIM, YELLOW, GREEN, GREEN, CYAN, BOLD + GREEN])}\n`;

  out += `${DIM}${sumSep}${RESET}\n`;

  out += `${formatSumRow([
    'ALL ECOSYSTEM',
    `${aSum.count} pkgs`,
    `${aSum.avg_days_live}d`,
    `${aSum.avg_day.toLocaleString(undefined, { minimumFractionDigits: 1 })} / day`,
    `${aSum.avg_month.toLocaleString(undefined, { minimumFractionDigits: 1 })} / mo`,
    `${aSum.avg_lifetime.toLocaleString(undefined, { minimumFractionDigits: 1 })} / pkg`,
    aSum.total_lifetime.toLocaleString()
  ], [BOLD + CYAN, BOLD, BOLD + YELLOW, BOLD + GREEN, BOLD + GREEN, BOLD + CYAN, BOLD + GREEN], true)}\n`;

  out += `${BOLD}${CYAN}${border}${RESET}\n`;

  // Detailed Second Table: What They Do
  if (detailed) {
    out += `\n${BOLD}${CYAN}${border}${RESET}\n`;
    out += `                                      ${BOLD}PROGRAM DIRECTORY & WHAT THEY DO${RESET}\n`;
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
    const descWidth = Math.max(60, tableWidth - 6 - 3 - pkgWidth - 3);

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

  const modeHint = !detailed ? '  •  Detailed mode: --detailed (or -d)' : '';
  out += `${DIM}Config: ${configPath || 'packages.json'}${outputPath ? '  •  Output: ' + outputPath : ''}${modeHint}${RESET}\n\n`;

  return out;
}
