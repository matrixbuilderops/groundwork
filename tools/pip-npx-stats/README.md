# pip-npx-stats

> Cross-Registry Package Telemetry & Download Engine for PyPI (`pip`) and NPM (`npx`) packages.

Run instantly with `npx`:

```bash
npx pip-npx-stats
# or:
npx pip-and-npx-package-stats
```

---

## Features

- **Cross-Registry Telemetry:** Simultaneously tracks PyPI (`pip`) packages and NPM (`npx`) packages in one unified terminal dashboard.
- **Zero Dependencies:** Pure native Node.js 18+ ESM. Executes instantly via `npx` with zero installation overhead.
- **Concurrent Engine:** Queries PyPI release timelines, PyPIStats ranges, NPM time maps, and NPM point/range APIs concurrently via `Promise.all`.
- **Purely Data-Driven:** Monitored packages and descriptions are loaded dynamically from a simple `packages.json` file. Add a package to the file and the engine automatically picks it up on the next run.
- **Live Metadata Fallback:** If a description is omitted in your JSON file, the engine automatically extracts the live summary directly from the PyPI or NPM registry API.
- **DNS-over-HTTPS (DoH) Resilience:** Automatically falls back to Cloudflare (`1.1.1.1`) and Google (`8.8.8.8`) DoH resolvers if local ISP DNS resolvers encounter `SERVFAIL` or `ENOTFOUND`.
- **Outage Protection:** Automatically caches verified telemetry so transient registry drops or upstream rate limits never zero out your numbers.

---

## Configuration File (`packages.json`)

The configuration file is divided into `pip` and `npm` arrays:

```json
{
  "pip": [
    "requests",
    "fastapi"
  ],
  "npm": [
    "express",
    "chalk",
    "zod"
  ],
  "descriptions": {
    "requests": "A simple, elegant HTTP library for Python.",
    "fastapi": "High performance web framework for building APIs with Python.",
    "express": "Fast, unopinionated, minimalist web framework for Node.js.",
    "zod": "TypeScript-first schema validation with static type inference."
  }
}
```

### Config File Lookup Order

When running `npx pip-npx-stats`, the tool searches for your configuration file in this order:
1. Custom path specified via `--config <path>`
2. `./packages.json` in the current working directory
3. `./packages_config.json` in the current working directory
4. `~/.config/pip-npx-stats/packages.json` in your user home directory
5. Bundled default `packages.json` shipped with the package

To create a starter `packages.json` in your current folder:
```bash
npx pip-npx-stats --init
```

---

## CLI Usage

### View Telemetry Dashboard
```bash
# Standard metrics table + ecosystem summary
npx pip-npx-stats

# Detailed mode (includes second table listing what each program does)
npx pip-npx-stats --detailed
# or:
npx pip-npx-stats -d

# Output calculated metrics as raw JSON
npx pip-npx-stats --json
```

### Manage Packages from the CLI
```bash
# Add packages to monitoring (saved directly to packages.json)
npx pip-npx-stats --add-pip <package-name>
npx pip-npx-stats --add-npm <package-name>

# Add a package with an explicit description
npx pip-npx-stats --add-pip my-tool --desc "Core audit engine"

# Update a description in packages.json
npx pip-npx-stats --set-desc my-tool "Updated engine description"

# Remove packages
npx pip-npx-stats --remove-pip <package-name>
npx pip-npx-stats --remove-npm <package-name>

# List all configured packages
npx pip-npx-stats --list
```

---

## Output Preview

```
=========================================================================================================================================
                                   ALEXANDER SORRELL — PACKAGE METRICS & TELEMETRY
=========================================================================================================================================
Type   │ Package           │ First Rel. │ First Date  │ Current    │ Updated     │  Days Live │   DL / Day │   DL / Month │   Lifetime DL
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
pip    │ cli-enforcement   │ v0.1.0     │ 2026-06-29  │ v0.9.0     │ 2026-08-29  │        69d │      121.5 │        3,543 │         8,383
pip    │ cli-wikia         │ v0.10.0    │ 2026-06-29  │ v0.20.0    │ 2026-08-29  │        69d │      105.9 │        3,946 │         7,310
pip    │ cli-collective    │ v0.1.0     │ 2026-06-29  │ v0.7.0     │ 2026-08-29  │        69d │       88.9 │        3,101 │         6,135
pip    │ cli-fleet         │ v0.1.0     │ 2026-06-29  │ v0.8.0     │ 2026-08-29  │        69d │       78.9 │        2,811 │         5,446
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
npx    │ starforge-cli     │ v0.1.0     │ 2026-08-07  │ v0.14.0    │ 2026-08-13  │        30d │      153.4 │        1,214 │         4,601
npx    │ sitemap-mcp       │ v0.1.0     │ 2026-08-13  │ v0.7.0     │ 2026-08-28  │        24d │       42.2 │        1,012 │         1,012
npx    │ filelens-mcp      │ v0.1.0     │ 2026-08-13  │ v0.7.0     │ 2026-08-28  │        24d │       42.0 │        1,008 │         1,008
npx    │ starreckon        │ v0.14.0    │ 2026-08-14  │ v0.24.0    │ 2026-09-05  │        23d │       53.7 │        1,236 │         1,236
npx    │ verifier-mcp      │ v1.0.0     │ 2026-09-04  │ v1.0.0     │ 2026-09-04  │         2d │       76.0 │          152 │           152
npx    │ sorrell-engine-mcp │ v1.0.0     │ 2026-09-04  │ v1.0.0     │ 2026-09-04  │         2d │       70.5 │          141 │           141
=========================================================================================================================================
                                              AVERAGES & SUMMARY
=========================================================================================================================================
Category         │   Packages │  Avg Days Live │   Avg DL / Day │   Avg DL / Month │   Avg Lifetime / Pkg │  Total Lifetime DL
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
PyPI (pip)       │     4 pkgs │            69d │     98.8 / day │     3,350.3 / mo │        6,818.5 / pkg │             27,274
NPM (npx)        │     6 pkgs │          17.5d │     73.0 / day │       793.8 / mo │        1,358.3 / pkg │              8,150
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
ALL ECOSYSTEM    │    10 pkgs │          38.1d │     83.3 / day │     1,816.4 / mo │        3,542.4 / pkg │             35,424
=========================================================================================================================================

=========================================================================================================================================
                                      PROGRAM DIRECTORY & WHAT THEY DO
=========================================================================================================================================
Type   │ Package             │ What It Does / Architecture
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
pip    │ cli-enforcement     │ Model-agnostic hook-level behavioral enforcement engine for AI coding agents.
pip    │ cli-wikia           │ Offline, pip-installable reference wiki & search index for AI CLIs (Claude, Gemini, Copilot, DeepSeek).
pip    │ cli-collective      │ The Collective bundle: knowledge (cli-wikia) + control (cli-enforcement) + parallel execution (cli-fleet).
pip    │ cli-fleet           │ Hardware-aware parallel Claude Code agent orchestration via shared filesystem mailboxes.
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
npx    │ starforge-cli       │ Verification CLI auditing AI-coding telemetry with kernel-enforced no-egress proof.
npx    │ sitemap-mcp         │ MCP server providing website structural awareness without HTML token explosion.
npx    │ filelens-mcp        │ MCP server for single-call intelligent AST & structural file reading.
npx    │ starreckon          │ Local-only developer wrapped analyzer for disk logs (Claude Code, Cowork, Codex).
npx    │ verifier-mcp        │ Deterministic EU e-invoice compliance engine and paradox resolver (DevNetwork 2026).
npx    │ sorrell-engine-mcp  │ Browser-native neural OS & Tiny Model Swarm runtime (OpenAI WebMCP Challenge).
=========================================================================================================================================
```

---

## License

PolyForm Noncommercial 1.0.0
