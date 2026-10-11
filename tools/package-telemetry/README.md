# package-telemetry

> Unified Cross-Registry Package Telemetry & Download Engine for PyPI and NPM packages.

Run instantly with `npx`:

```bash
npx package-telemetry
# or detailed mode:
npx package-telemetry --detailed
```

---

## Features

- **Cross-Registry Telemetry:** Simultaneously tracks PyPI (`pip`) packages and NPM (`npx`) packages in one unified terminal dashboard.
- **Zero Dependencies:** Pure native Node.js 18+ ESM. Executes instantly via `npx` with zero installation overhead.
- **Concurrent Engine:** Queries PyPI release timelines, PyPIStats ranges, NPM time maps, and NPM point/range APIs concurrently via `Promise.all`.
- **Purely Data-Driven:** Monitored packages and descriptions are loaded dynamically from a simple `packages.json` file. Add a package to the file and the engine automatically picks it up on the next run.
- **Live Metadata Fallback:** If a description is omitted in your JSON file, the engine automatically extracts the live summary directly from the PyPI or NPM registry API.
- **DNS Resilience:** Automatically switches the default resolver to Cloudflare (`1.1.1.1`) and Google (`8.8.8.8`) via `dns.setServers` if local ISP DNS resolvers encounter `SERVFAIL` or `ENOTFOUND`, then retries with the original hostname (TLS/SNI intact).
- **Honest PyPI Numbers:** Headline PyPI download counts exclude mirror traffic (`without_mirrors`); mirror-inflated totals are still reported in `*_with_mirrors` fields for transparency.
- **Outage Protection:** Automatically caches verified telemetry so transient registry drops or upstream rate limits never zero out your numbers.

---

## Configuration File (`packages.json`)

The configuration file is divided into `pip` and `npx` (or `npm`) arrays:

```json
{
  "pip": [
    "cli-enforcement"
  ],
  "npx": [
    "filelens-mcp"
  ],
  "descriptions": {
    "cli-enforcement": "Model-agnostic hook-level behavioral enforcement engine for AI coding agents.",
    "filelens-mcp": "MCP server for single-call intelligent AST & structural file reading."
  }
}
```

### Config File Lookup Order

When running `npx package-telemetry`, the tool searches for your configuration file in this order:
1. Custom path specified via `--config <path>` (warns and continues if missing)
2. `./packages.json` in the current working directory
3. `./packages_config.json` in the current working directory
4. `~/.config/package-telemetry/packages.json` in your user home directory
5. `~/.config/pip-npx-stats/packages.json` (legacy path, still honored)
6. Bundled default `packages.json` shipped with the package

Corrupt JSON in an existing config file is a hard error — the tool reports it instead of silently substituting defaults.

To create a starter `packages.json` in your current folder:
```bash
npx package-telemetry --init
```

---

## CLI Usage

### View Telemetry Dashboard
```bash
# Standard metrics table + ecosystem summary
npx package-telemetry

# Detailed mode (includes second table listing what each program does)
npx package-telemetry --detailed
# or:
npx package-telemetry-detailed

# Runs mode (pairs every download column with runs: R-Day, R-Today, R-30d from
# jsDelivr CDN serves; R-Life is n/a since jsDelivr retains 30 days only; plus CDN Rank)
npx package-telemetry --runs
# or:
npx package-telemetry-runs

# Output calculated metrics as raw JSON
npx package-telemetry --json
```

### Manage Packages from the CLI
```bash
# Add packages to monitoring (saved directly to packages.json)
npx package-telemetry --add-pip <package-name>
npx package-telemetry --add-npm <package-name>

# Add a package with an explicit description
npx package-telemetry --add-pip my-tool --desc "Core audit engine"

# Update a description in packages.json
npx package-telemetry --set-desc my-tool "Updated engine description"

# Remove packages
npx package-telemetry --remove-pip <package-name>
npx package-telemetry --remove-npm <package-name>

# List all configured packages
npx package-telemetry --list
```

### Run the Tests
```bash
npm test
```
Zero-dependency suite on the built-in `node:test` runner: `calcGroup` units, pip headline/`--real-only` contract and npm last-day units (stubbed fetcher, no network), `fetchJson` retry semantics (stubbed `fetch`), pepy fallback chain, responsive widths, history record/prune/trend units, config error handling, and a `--no-save` fixture CLI run.

### Growth History (`--trend`)

Every saved run appends a lean snapshot to `package_telemetry_history.jsonl`
next to the cache (stale runs are never recorded; the file keeps the last
2,000 snapshots). `--trend` renders lifetime + 7/30-day deltas per package,
comparing only snapshots from the same mirror mode. `--no-save` skips
recording; `--trend --json` dumps the raw deltas.

### Responsive Tables

On a live terminal the table compacts itself to fit your window: metadata
columns (`First Date`, `First Rel.`, `Days Live`, `Updated`, `Current`) shed
first, then long package names truncate with `…`. Download, runs, and rank
columns are never dropped. Piped output stays full-width; `--full` forces the
full table on a terminal.

## Data Sources

Every row records which backend served it (`downloads_source` in `--json`):

| Metric | Primary | Fallback |
|---|---|---|
| pip downloads | [pypistats.org](https://pypistats.org) `with_mirrors` (everything counted; mirror-excluded series in `*_real`, `--real-only` headlining it) | [pepy.tech](https://pepy.tech) (live, mirrors included; flagged in the footer) |
| npm downloads | [api.npmjs.org](https://api.npmjs.org) (npm's official counts endpoint — the only dataset; npm-stat, npmtrends, etc. re-serve it) | cached snapshot |
| npm runs + rank | [jsDelivr stats API](https://www.jsdelivr.com/docs/data.jsdelivr.com) (CDN file serves, trailing 30 days) | cached snapshot |
| Metadata | registry.npmjs.org / pypi.org | cached snapshot |

When every live source fails, the last cached snapshot is used and marked `~`.

---

## License

PolyForm Noncommercial License 1.0.0
