#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveConfigPath,
  loadConfig,
  saveConfig,
  computeMetrics,
  renderTable
} from '../src/telemetry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_NAME = path.basename(process.argv[1] || 'pip-npx-stats');

function printHelp() {
  console.log(`
================================================================================
                                 pip-npx-stats
     Cross-Registry Package Telemetry Engine for PyPI (pip) & NPM (npx)
================================================================================

HOW IT WORKS:
  1. Reads your \`packages.json\` divided into "pip" and "npm" package arrays.
  2. Queries official PyPI and NPM registry & download APIs concurrently.
  3. Computes release dates, days live, DL/day, DL/month, and lifetime downloads.
  4. Renders a unified ANSI terminal dashboard with cross-ecosystem summaries.
  5. In Detailed Mode, renders a second table listing what each program does.

MODES:
  --detailed, -d             Display second table ("PROGRAM DIRECTORY & WHAT THEY DO")
                             listing what each program does under the main table.
                             Descriptions are loaded from the "descriptions" section
                             of packages.json, or automatically fetched from the
                             package's live registry summary if omitted.
                             (Shortcut: run directly as \`pip-npx-stats-detailed\`)

  --json                     Output calculated telemetry metrics as JSON to stdout.

  --init                     Initialize a starter packages.json in current directory
                             with example PyPI and NPM packages.

CONFIG MANAGEMENT:
  --add-pip <name>           Add a PyPI package to packages.json
  --add-npm <name>           Add an NPM package to packages.json
  --desc "<description>"     Optional description when adding package via --add-pip/npm
  --set-desc <pkg> "<desc>"  Set or update description for a package in packages.json
  --remove-pip <name>        Remove a PyPI package from packages.json
  --remove-npm <name>        Remove an NPM package from packages.json
  --list                     Print current monitored packages from JSON config
  --config <path>            Specify custom path to packages.json config file
  --no-save                  Do not save latest telemetry to local cache file
  -h, --help                 Show this help message

CONFIGURATION FILE (packages.json):
  The JSON file is divided into "pip" and "npm" sections:

  {
    "pip": [
      "requests",
      "fastapi"
    ],
    "npm": [
      "express",
      "chalk"
    ],
    "descriptions": {
      "requests": "A simple, elegant HTTP library for Python.",
      "express": "Fast, unopinionated, minimalist web framework for Node.js."
    }
  }

  • Add ANY package to "pip" or "npm" and the engine automatically picks it up!
  • "descriptions" is optional. If omitted, the engine automatically extracts
    the live summary directly from the PyPI or NPM registry metadata.

EXAMPLES:
  # Run standard telemetry dashboard
  npx pip-npx-stats

  # Run detailed mode (includes second table listing what each program does)
  npx pip-npx-stats --detailed
  # or:
  npx pip-npx-stats-detailed

  # Initialize a new packages.json in your current folder
  npx pip-npx-stats --init

  # Add packages directly from the command line
  npx pip-npx-stats --add-pip flask --desc "Lightweight WSGI web application framework"
  npx pip-npx-stats --add-npm zod --desc "TypeScript-first schema validation"

  # Output raw JSON to pipe into jq or save to disk
  npx pip-npx-stats --json > metrics.json
`);
}

async function main() {
  const args = process.argv.slice(2);

  let isDetailed = SCRIPT_NAME.includes('detailed') || args.includes('detailed');
  let isJson = false;
  let noSave = false;
  let customConfigPath = null;
  let addPip = null;
  let addNpm = null;
  let removePip = null;
  let removeNpm = null;
  let descArg = null;
  let setDescPkg = null;
  let setDescVal = null;
  let isInit = false;
  let isList = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (a === '-d' || a === '--detailed') {
      isDetailed = true;
    } else if (a === '--json') {
      isJson = true;
    } else if (a === '--no-save') {
      noSave = true;
    } else if (a === '--init') {
      isInit = true;
    } else if (a === '--list') {
      isList = true;
    } else if (a === '--config' && i + 1 < args.length) {
      customConfigPath = args[++i];
    } else if ((a === '--add-pip' || a === '--add-pypi') && i + 1 < args.length) {
      addPip = args[++i];
    } else if ((a === '--add-npm' || a === '--add-npx') && i + 1 < args.length) {
      addNpm = args[++i];
    } else if ((a === '--remove-pip' || a === '--remove-pypi') && i + 1 < args.length) {
      removePip = args[++i];
    } else if ((a === '--remove-npm' || a === '--remove-npx') && i + 1 < args.length) {
      removeNpm = args[++i];
    } else if (a === '--desc' && i + 1 < args.length) {
      descArg = args[++i];
    } else if (a === '--set-desc' && i + 2 < args.length) {
      setDescPkg = args[++i];
      setDescVal = args[++i];
    }
  }

  // Handle --init
  if (isInit) {
    const targetPath = path.join(process.cwd(), 'packages.json');
    if (fs.existsSync(targetPath)) {
      console.log(`packages.json already exists at ${targetPath}`);
    } else {
      const template = {
        pip: [
          'requests',
          'fastapi'
        ],
        npm: [
          'express',
          'chalk'
        ],
        descriptions: {
          'requests': 'A simple, elegant HTTP library for Python.',
          'fastapi': 'High performance web framework for building APIs with Python.',
          'express': 'Fast, unopinionated, minimalist web framework for Node.js.',
          'chalk': 'Terminal string styling done right.'
        }
      };
      saveConfig(template, targetPath);
      console.log(`Initialized starter packages.json at ${targetPath}`);
      console.log(`Add your package names to the "pip" or "npm" section and re-run!`);
    }
    process.exit(0);
  }

  // Resolve config file
  const configPath = resolveConfigPath(customConfigPath);
  const config = loadConfig(configPath);

  // Normalize pip & npm arrays
  if (!Array.isArray(config.pip)) config.pip = config.pypi || [];
  if (!Array.isArray(config.npm)) config.npm = config.npx || [];
  if (!config.descriptions) config.descriptions = {};

  // Handle mutations
  if (setDescPkg && setDescVal) {
    config.descriptions[setDescPkg] = setDescVal;
    saveConfig(config, configPath);
    console.log(`Updated description for '${setDescPkg}' in ${configPath}`);
    process.exit(0);
  }

  if (addPip) {
    if (!config.pip.includes(addPip)) {
      config.pip.push(addPip);
      if (descArg) config.descriptions[addPip] = descArg;
      saveConfig(config, configPath);
      console.log(`Added PyPI package '${addPip}' to ${configPath}`);
    } else {
      console.log(`PyPI package '${addPip}' is already in ${configPath}`);
    }
    process.exit(0);
  }

  if (addNpm) {
    if (!config.npm.includes(addNpm)) {
      config.npm.push(addNpm);
      if (descArg) config.descriptions[addNpm] = descArg;
      saveConfig(config, configPath);
      console.log(`Added NPM package '${addNpm}' to ${configPath}`);
    } else {
      console.log(`NPM package '${addNpm}' is already in ${configPath}`);
    }
    process.exit(0);
  }

  if (removePip) {
    if (config.pip.includes(removePip)) {
      config.pip = config.pip.filter(p => p !== removePip);
      delete config.descriptions[removePip];
      saveConfig(config, configPath);
      console.log(`Removed PyPI package '${removePip}' from ${configPath}`);
    } else {
      console.log(`PyPI package '${removePip}' was not found in ${configPath}`);
    }
    process.exit(0);
  }

  if (removeNpm) {
    if (config.npm.includes(removeNpm)) {
      config.npm = config.npm.filter(p => p !== removeNpm);
      delete config.descriptions[removeNpm];
      saveConfig(config, configPath);
      console.log(`Removed NPM package '${removeNpm}' from ${configPath}`);
    } else {
      console.log(`NPM package '${removeNpm}' was not found in ${configPath}`);
    }
    process.exit(0);
  }

  if (isList) {
    console.log(`\nMonitored Packages (${configPath}):`);
    console.log(JSON.stringify(config, null, 2));
    process.exit(0);
  }

  // Load cached telemetry if available for outage protection
  const cacheDir = path.dirname(configPath);
  const cacheFile = path.join(cacheDir, 'package_telemetry_latest.json');
  let cachedData = {};
  try {
    if (fs.existsSync(cacheFile)) {
      cachedData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  } catch {}

  // Compute metrics
  const data = await computeMetrics(config, cachedData);

  // Cache to disk unless --no-save
  if (!noSave) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch {}
  }

  if (isJson) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    process.stdout.write(renderTable(data, {
      detailed: isDetailed,
      configPath,
      outputPath: !noSave ? cacheFile : ''
    }));
  }
}

main().catch(err => {
  console.error('Execution error:', err);
  process.exit(1);
});
