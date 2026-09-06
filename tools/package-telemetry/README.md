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
- **DNS-over-HTTPS (DoH) Resilience:** Automatically falls back to Cloudflare (`1.1.1.1`) and Google (`8.8.8.8`) DoH resolvers if local ISP DNS resolvers encounter `SERVFAIL` or `ENOTFOUND`.
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
1. Custom path specified via `--config <path>`
2. `./packages.json` in the current working directory
3. `./packages_config.json` in the current working directory
4. `~/.config/package-telemetry/packages.json` in your user home directory
5. Bundled default `packages.json` shipped with the package

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

---

## License

PolyForm Noncommercial License 1.0.0
