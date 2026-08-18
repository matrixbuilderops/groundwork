#!/usr/bin/env node
/**
 * Re-derives the accuracy claims in this package's README and source comments.
 *
 * The 99.93% / 96.47% figures were prose in a comment until this script existed
 * — true when written, unverifiable by anyone else. This turns them into a
 * command. Ground truth is Python's own `ast` module and the TypeScript
 * compiler, so the scanners are scored against real parsers, never against
 * their own previous output.
 *
 * Corpora are whatever this machine has: the Python stdlib, and any TypeScript
 * under node_modules. Both are optional — a missing corpus SKIPs rather than
 * fails, because CI without a Python 3 or without deps installed should not go
 * red over a measurement it cannot take.
 *
 *   node test/corpus.mjs [--min-python 99.5] [--min-ts 95.0] [--limit 400]
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "..", "build", "index.js");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}
const MIN_PY = arg("--min-python", 99.5);
const MIN_TS = arg("--min-ts", 95.0);
const LIMIT = arg("--limit", 400);

if (!fs.existsSync(BUILD)) {
  console.error("build/index.js missing — run `npm run build` first.");
  process.exit(2);
}

/** Import the scanners out of the built bundle without starting the server. */
async function loadScanners() {
  const src = fs.readFileSync(BUILD, "utf8");
  const from = src.indexOf("function pythonBlockEnd");
  const to = src.indexOf("function outlineMarkdown");
  if (from === -1 || to === -1) throw new Error("cannot locate scanners in build output");
  const mod = path.join(HERE, ".scanners.tmp.mjs");
  fs.writeFileSync(mod, src.slice(from, to) + "\nexport { outlinePython, outlineJS };\n");
  try {
    return await import(`file://${mod}?v=${fs.statSync(BUILD).mtimeMs}`);
  } finally {
    fs.rmSync(mod, { force: true });
  }
}

/** Every node in the tree, at any depth — outlines nest now. */
function flatten(nodes) {
  return nodes.flatMap(n => [n, ...flatten(n.children ?? [])]);
}

/** Same contract as readLines() in the server. */
function toLines(src) {
  const lines = src.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function findFiles(root, ext, limit) {
  const out = [];
  const walk = dir => {
    if (out.length >= limit) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (/^(__pycache__|\.git|test|tests)$/.test(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith(ext) && !e.name.endsWith(".d.ts")) {
        try { if (fs.statSync(p).size > 2048) out.push(p); } catch { /* unreadable */ }
      }
    }
  };
  walk(root);
  return out.sort();
}

async function scorePython(outlinePython) {
  let stdlib = null;
  try {
    stdlib = execFileSync("python3", ["-c", "import sysconfig;print(sysconfig.get_paths()['stdlib'])"],
      { encoding: "utf8" }).trim();
  } catch { /* no python3 */ }
  if (!stdlib || !fs.existsSync(stdlib)) return { skip: "python3 stdlib not found" };

  const files = findFiles(stdlib, ".py", LIMIT);
  if (files.length === 0) return { skip: "no .py corpus" };

  // One python3 process for the whole corpus: per-file spawns dominated runtime.
  const truth = JSON.parse(execFileSync("python3", ["-c", `
import ast, json, sys
out = {}
for f in json.loads(sys.stdin.read()):
    try: tree = ast.parse(open(f, encoding='utf-8', errors='replace').read())
    except SyntaxError: continue
    rows = {}
    def walk(n):
        for c in ast.iter_child_nodes(n):
            if isinstance(c, ast.ClassDef):
                rows[f"class:{c.name}:{c.lineno}"] = c.end_lineno; walk(c)
            elif isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef)):
                rows[f"func:{c.name}:{c.lineno}"] = c.end_lineno; walk(c)
            else: walk(c)
    walk(tree)
    out[f] = rows
json.dump(out, sys.stdout)
`], { input: JSON.stringify(files), encoding: "utf8", maxBuffer: 1 << 28 }));

  let total = 0, exact = 0;
  for (const f of files) {
    const rows = truth[f];
    if (!rows) continue;
    let src; try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const node of flatten(outlinePython(toLines(src)))) {
      const key = `${node.kind === "class" ? "class" : "func"}:${node.name}:${node.startLine}`;
      if (!(key in rows)) continue;
      total++;
      if (node.endLine === rows[key]) exact++;
    }
  }
  return { total, exact, files: files.length };
}

async function scoreTypeScript(outlineJS) {
  let ts;
  try { ts = createRequire(import.meta.url)("typescript"); } catch { return { skip: "typescript not installed" }; }
  if (!ts.createSourceFile) return { skip: `typescript ${ts.version} has no JS compiler API` };

  const roots = [path.join(HERE, "..", "node_modules"), path.join(HERE, "..", "..", "..", "node_modules")]
    .filter(p => fs.existsSync(p));
  const files = roots.flatMap(r => findFiles(r, ".ts", LIMIT)).slice(0, LIMIT);
  if (files.length === 0) return { skip: "no .ts corpus" };

  let total = 0, exact = 0;
  for (const f of files) {
    let src; try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true);
    const line = p => sf.getLineAndCharacterOfPosition(p).line + 1;
    const truth = new Map();
    (function walk(n) {
      let name = null;
      if (ts.isFunctionDeclaration(n) && n.name) name = n.name.text;
      else if (ts.isClassDeclaration(n) && n.name) name = n.name.text;
      else if (ts.isMethodDeclaration(n) && n.name) name = n.name.getText(sf);
      else if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) &&
               (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) name = n.name.text;
      if (name) truth.set(`${name}@${line(n.getStart(sf))}`, line(n.getEnd()));
      ts.forEachChild(n, walk);
    })(sf);
    for (const n of flatten(outlineJS(toLines(src)))) {
      const key = `${n.name}@${n.startLine}`;
      if (!truth.has(key)) continue;
      total++;
      if (n.endLine === truth.get(key)) exact++;
    }
  }
  return { total, exact, files: files.length };
}

const { outlinePython, outlineJS } = await loadScanners();
let failed = false;

for (const [label, result, floor] of [
  ["python endLine vs ast", await scorePython(outlinePython), MIN_PY],
  ["ts endLine vs tsc", await scoreTypeScript(outlineJS), MIN_TS],
]) {
  if (result.skip) { console.log(`SKIP  ${label} — ${result.skip}`); continue; }
  if (result.total === 0) { console.log(`SKIP  ${label} — no comparable symbols`); continue; }
  const pct = (result.exact / result.total) * 100;
  const ok = pct >= floor;
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${result.exact}/${result.total} exact = ${pct.toFixed(2)}% (floor ${floor}%, ${result.files} files)`);
}

process.exit(failed ? 1 : 0);
