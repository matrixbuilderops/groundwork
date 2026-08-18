#!/usr/bin/env node
/**
 * FileLens MCP Server
 *
 * Collapses multiple file-reading tool calls into single structured results.
 * Designed for AI agents that already have file access tools but want to
 * reduce round trips by getting structure + content in one shot.
 *
 * Tools exposed:
 *   file_outline        — structure scan: classes, functions, headings + line numbers
 *   file_search         — keyword/regex search with context lines
 *   file_chunk          — precise line-range extraction with line numbers
 *   file_summarize      — outline + head + tail in one call
 *   file_fetch          — outline + targeted chunk in one call (the key power tool)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";

const server = new McpServer({ name: "filelens", version: "0.4.0" });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Refuse anything this big as text; a source file is never close. */
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
/** Bytes sniffed for a NUL before deciding a file is binary. */
const SNIFF_BYTES = 8192;

/**
 * Reject binaries before they are rendered as source.
 *
 * `file_chunk("/bin/ls", 1, 2)` returned 5,773 chars of ELF with a line-number
 * gutter drawn down the side. That is the worst output this server can produce,
 * because it is not an error — an agent will try to reason about it. A NUL byte
 * in the first 8 KiB is the same rule `grep -I` and `git` use. UTF-16 text is
 * full of NULs, so a BOM is checked first and wins.
 */
function assertTextFile(resolved: string): void {
  const size = fs.statSync(resolved).size;
  if (size > MAX_TEXT_BYTES) {
    throw new Error(`File is ${size} bytes, over the ${MAX_TEXT_BYTES}-byte text limit. Use file_chunk with a line range.`);
  }
  if (size === 0) return;
  const fd = fs.openSync(resolved, "r");
  try {
    const buf = Buffer.alloc(Math.min(SNIFF_BYTES, size));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const bom16 = read >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
    if (!bom16 && buf.subarray(0, read).includes(0)) {
      throw new Error(`File appears to be binary (NUL byte within the first ${read} bytes) — refusing to render it as text.`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Optional roots the server may read under. Empty means unrestricted.
 *
 * This deliberately inverts sitemap's SITEMAP_ALLOW_PRIVATE default, because
 * the authority is inverted. sitemap's SSRF grants reach the caller does not
 * otherwise have — the server's network position can touch 169.254.169.254.
 * Reading a local file grants none: same uid, same files the agent's own shell
 * already opens. Default-deny here would break ordinary work — this package's
 * own accuracy corpus is the Python stdlib, which lives outside any project
 * root, as do node_modules, /nix/store, monorepo siblings and git worktrees —
 * and it would fail badly: a stdio server cannot prompt, so it would return an
 * error, the agent would quietly fall back to its own file reader, and the
 * server would be dead weight nobody notices is inert.
 *
 * Set FILELENS_ROOTS (colon-separated) to opt into confinement.
 */
const ROOTS = (process.env.FILELENS_ROOTS ?? "")
  .split(":").map(s => s.trim()).filter(Boolean)
  .map(r => { try { return fs.realpathSync(path.resolve(r)); } catch { return path.resolve(r); } });

function assertAllowedPath(resolved: string): string {
  // realpath before comparing: path.resolve plus a string prefix is defeated by
  // a single symlink pointing out of the root.
  let real: string;
  try { real = fs.realpathSync(resolved); } catch { real = resolved; }
  if (ROOTS.length === 0) return real;
  const ok = ROOTS.some(root => real === root || real.startsWith(root + path.sep));
  if (!ok) {
    throw new Error(
      `Path is outside FILELENS_ROOTS: ${real}${real === resolved ? "" : ` (via symlink from ${resolved})`}. ` +
      `Allowed roots: ${ROOTS.join(", ")}. Unset FILELENS_ROOTS to remove the restriction.`
    );
  }
  return real;
}

function readLines(filePath: string): string[] {
  const resolved = assertAllowedPath(path.resolve(filePath));
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  if (fs.statSync(resolved).isDirectory()) throw new Error(`Not a file (it is a directory): ${resolved}`);
  assertTextFile(resolved);
  // split("\n") kept the empty string after the file's final newline as a line,
  // so every file read exactly one line too long — 126/126 corpus files, e.g.
  // 2687 for a 2686-line sessions.py, and 1 for a 0-byte file. file_chunk then
  // served that phantom line as content. \r?\n also drops the CR that CRLF
  // files were leaking into the end of every emitted line.
  const lines = fs.readFileSync(resolved, "utf-8").split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    // .mjs/.cjs and .mts/.cts were missing, so every ES-module project read as
    // "text" and outlineJS never ran: a 438-line .mjs returned 0 symbols while
    // the same code in a .js file returned its full outline. The JS parser was
    // always correct — it just never got reached.
    ".py": "Python", ".js": "JavaScript", ".mjs": "JavaScript",
    ".cjs": "JavaScript", ".jsx": "JavaScript",
    ".ts": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
    ".tsx": "TypeScript", ".md": "Markdown",
    ".go": "Go", ".rs": "Rust", ".java": "Java", ".rb": "Ruby",
    ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
    ".json": "JSON", ".yaml": "YAML", ".yml": "YAML",
    ".toml": "TOML", ".html": "HTML", ".css": "CSS", ".cpp": "C++",
    ".c": "C", ".h": "C", ".hpp": "C++", ".cs": "C#",
  };
  return map[ext] ?? "text";
}

/**
 * Which languages actually have a scanner.
 *
 * detectLanguage names 28 extensions; buildOutline dispatches on 4 of them. A
 * .rs file therefore reported `LANGUAGE: Rust`, a line count, and zero symbols
 * — indistinguishable from a Rust file that genuinely defines nothing. Naming
 * the gap in-band is the same discipline sitemap applies when it strips a
 * block: say what you did not do, because silence looks like a real answer.
 */
const PARSED_LANGUAGES = new Set(["Python", "JavaScript", "TypeScript", "Markdown"]);

function parserNote(lang: string, nodeCount: number): string | null {
  if (PARSED_LANGUAGES.has(lang)) return null;
  if (nodeCount > 0) return null;
  return lang === "text"
    ? "NOTE: unrecognised extension — no structure scanner ran. Line ranges and file_chunk still work."
    : `NOTE: ${lang} has no structure scanner in filelens yet — this outline is empty because nothing parsed it, not because the file is empty. Line ranges and file_chunk still work.`;
}

interface OutlineNode {
  kind: string;
  name: string;
  startLine: number;
  endLine?: number;
  children: OutlineNode[];
}

// endLine was `lineNum - 1` — the line before the next top-level def, which is
// not where anything ends. altair/utils/core.py reported `class DataFrameLike
// lines 61–223` for a class that ends at 64, and every `def` carried no end at
// all, so the outline was a list of pins: you could see that parse_shorthand
// started at 517 but had to guess where to stop reading. The two scanners below
// compute the real end — measured against Python's own ast over 400 stdlib
// files (15,340/15,350 exact, 99.93%) and against the TypeScript compiler over
// 205 hand-written zod/ajv sources (1,091/1,131 exact, 96.5%).

/** Last line of a Python def/class body, 1-indexed. */
function pythonBlockEnd(lines: string[], startIdx: number, headerIndent: number): number {
  // The signature can span lines, so find where the body actually starts.
  let depth = 0;
  let sigEnd = startIdx;
  for (let i = startIdx; i < lines.length; i++) {
    const code = lines[i].replace(/#.*$/, "");
    for (const ch of code) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
    }
    sigEnd = i;
    if (depth <= 0) {
      const colon = code.lastIndexOf(":");
      if (colon !== -1) {
        // `def _f(): pass` puts the body on the header line and ends there.
        // Without this the scan runs to EOF hunting a line that ends in ":".
        if (code.slice(colon + 1).trim() !== "") return i + 1;
        break;
      }
    }
  }
  // The body is every line indented past the header. Blank lines and full-line
  // comments belong to whatever surrounds them — a `#` flush at column 0 inside
  // a class body must not end the class (aifc.py, asyncio/*).
  let end = sigEnd;
  let quote: string | null = null;
  for (let j = sigEnd + 1; j < lines.length; j++) {
    const line = lines[j];
    if (quote) {
      // A file that handles quote characters as data (ast.py, tokenize.py) can
      // fool the delimiter count; never let that swallow the rest of the file.
      if (line.length - line.trimStart().length <= headerIndent &&
          /^\s*(?:@|(?:async\s+)?def\s|class\s)/.test(line)) break;
      end = j;
      if (line.includes(quote)) quote = null;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= headerIndent) break;
    end = j;
    // An odd count means one delimiter is left open.
    if ((trimmed.match(/"""/g) || []).length % 2 === 1) quote = '"""';
    else if ((trimmed.match(/'''/g) || []).length % 2 === 1) quote = "'''";
  }
  return end + 1;
}

/** Last line of a brace-delimited JS/TS block, 1-indexed. */
function braceBlockEnd(lines: string[], startIdx: number): number {
  const LOOKAHEAD = 20;
  let depth = 0;
  let started = false;
  let inBlockComment = false;
  for (let i = startIdx; i < lines.length; i++) {
    if (!started && i - startIdx > LOOKAHEAD) return startIdx + 1;
    const line = lines[i];
    let str: string | null = null;
    let tail = "";
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      const n = line[k + 1];
      if (inBlockComment) {
        if (c === "*" && n === "/") { inBlockComment = false; k++; }
        continue;
      }
      if (str) {
        if (c === "\\") k++;
        else if (c === str) str = null;
        continue;
      }
      if (c === "/" && n === "/") break;
      if (c === "/" && n === "*") { inBlockComment = true; k++; continue; }
      if (c.trim() !== "") tail = (tail + c).slice(-2);
      if (c === '"' || c === "'" || c === "`") { str = c; continue; }
      if (c === "{") { depth++; started = true; }
      else if (c === "}") depth--;
    }
    // Settle only at a line boundary. A TS type annotation such as
    // `): { [k in U[number]]: k } => {` opens and closes a brace mid-line, and
    // treating that as the body truncated the block to its first line.
    if (tail === "=>") continue;
    if (started && depth <= 0) return i + 1;
    // An expression-bodied arrow never opens a brace; it ends at its statement.
    if (!started && depth <= 0 && tail.endsWith(";")) return i + 1;
  }
  return started ? lines.length : startIdx + 1;
}

/**
 * Which lines sit inside a triple-quoted string.
 *
 * Docstrings routinely contain example code, and `^class`/`^def` matched it:
 * abc.py contributed four phantom symbols from the usage examples in its module
 * docstring alone. The opening line is not masked — a `"""` that opens on the
 * same line as real code should not hide that code.
 */
function docstringMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let triple: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (triple) mask[i] = true;
    let k = 0;
    while (k < line.length) {
      if (triple) {
        if (line.startsWith(triple, k)) { triple = null; k += 3; continue; }
        k++;
        continue;
      }
      const c = line[k];
      if (c === "#") break;
      if (c === '"' || c === "'") {
        const three = line.slice(k, k + 3);
        if (three === '"""' || three === "'''") { triple = three; k += 3; continue; }
        // A single-quoted string, which is where a bare `'''` hides: counting
        // delimiters per line made `QUOTE_AS_DATA = "'''"` open a docstring and
        // mask the whole rest of the file.
        k++;
        while (k < line.length) {
          if (line[k] === "\\") { k += 2; continue; }
          if (line[k] === c) { k++; break; }
          k++;
        }
        continue;
      }
      k++;
    }
  }
  return mask;
}

function outlinePython(lines: string[]): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  const inDocstring = docstringMask(lines);

  for (let i = 0; i < lines.length; i++) {
    if (inDocstring[i]) continue;
    const line = lines[i];
    const lineNum = i + 1;

    // `^class` only ever matched column zero, so a class nested in a class, a
    // try block or an `if` was invisible and its methods were reparented onto
    // whatever class came before it.
    const classMatch = line.match(/^(\s*)class\s+(\w+)/);
    if (classMatch) {
      nodes.push({
        kind: "class", name: classMatch[2], startLine: lineNum,
        endLine: pythonBlockEnd(lines, i, classMatch[1].length), children: [],
      });
      continue;
    }

    const fnMatch = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)/);
    if (fnMatch) {
      nodes.push({
        kind: "def", name: fnMatch[2], startLine: lineNum,
        endLine: pythonBlockEnd(lines, i, fnMatch[1].length), children: [],
      });
    }
  }
  // Parent by containment rather than by "indented, and a class was seen
  // earlier": that rule filed a def nested inside a function as a method of the
  // enclosing class, and every def after a nested class under the wrong parent.
  return nestByContainment(nodes);
}

function outlineJS(lines: string[]): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  const patterns: [RegExp, string][] = [
    [/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/, "function"],
    // `export default class Foo` matched nothing, so the default export — the
    // one symbol a reader is most likely to want — was missing from the outline.
    [/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/, "class"],
    // `^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(` demanded a paren
    // immediately after `=` at column 0, so it saw none of the shapes TS
    // actually writes: an arrow inside a namespace (zod's util.ts declares 20
    // that way), a generic `<T>(…) =>`, a `: Type =` annotation before the
    // arrow, or a single unparenthesised parameter. Requiring the `=>` instead
    // of a bare `(` also stops `const x = (a + b)` being called a function.
    [/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:<[^>]*>\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=>]+)?=>/, "arrow fn"],
    // ^\s{2,}(\w+)\s*\( matched anything that opened a paren after an indent, so
    // `if (`, `for (` and bare call sites all came back as methods: 3.1% of its
    // "method" nodes were real across 500 files (1,868 true / 58,063 false), and
    // 0 of scan.mjs's 101. \s{2,} also could not match a single tab, so
    // tab-indented classes returned no methods at all. The pieces below, in
    // order: \s+ picks up the one-tab indent; the keyword list drops control
    // flow; (?![^)]*\bfunction\b) drops `it("x", function () {`-shaped call
    // sites; \)\s*(?::…)?\s*\{ requires a body to open on the same line (with an
    // optional TS return type) which drops the remaining call sites. Measured on
    // the same 500 files: 1,844 true / 7 false — 99.6% precision at 79.0% recall
    // versus the old 3.1% / 80.1%. Known cost: a real method named `catch`, and
    // any signature whose `{` is on the next line, are missed.
    [/^\s+(?:static\s+)?(?:async\s+)?(?!(?:if|for|while|switch|catch|do|return|typeof|await|new|function)\b)(\w+)\s*\((?![^)]*\bfunction\b)[^)]*\)\s*(?::[^{;]+)?\s*\{/, "method"],
    // Accessors read as `get size()`, so the pattern above bound `get` as the
    // name and then failed on the space before `size`.
    [/^\s+(?:static\s+)?(?:get|set)\s+(\w+)\s*\([^)]*\)\s*(?::[^{;]+)?\s*\{/, "accessor"],
    // A multi-line arrow signature has no `=>` on its declaring line. Allowing
    // nothing but `async` and generics between `=` and `(` is what separates
    // `const f = (` from the call `const x = foo(`.
    [/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:<[^>]*>\s*)?\(\s*$/, "arrow fn"],
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const [pattern, kind] of patterns) {
      const m = lines[i].match(pattern);
      if (m) {
        nodes.push({ kind, name: m[1], startLine: i + 1, endLine: braceBlockEnd(lines, i), children: [] });
        break;
      }
    }
  }
  return nestByContainment(nodes);
}

/**
 * Turn a flat, ordered symbol list into a tree using the ranges.
 *
 * outlineJS pushed every node with `children: []`, so a class and its methods
 * were siblings and `arrow fn note lines 342` rendered next to the
 * `function fitToBudget lines 341–353` that contains it. Containment is exact
 * now, so nesting needs no extra parsing: a node belongs to the nearest open
 * ancestor whose range covers it. Python keeps its own indentation-based
 * parenting, which is measured at 99.97% and has no reason to change.
 */
function nestByContainment(flat: OutlineNode[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const node of flat) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const covers = top.endLine !== undefined && node.startLine > top.startLine && node.startLine <= top.endLine;
      if (covers) break;
      stack.pop();
    }
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}

function outlineMarkdown(lines: string[]): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  // With no fence state, every `#` shell comment inside a ```bash block was an
  // h1: a 1,729-line README reported 63 headings where commonmark sees 41, and
  // one wrapped sentence became three sibling h1 sections. Tracking which
  // marker opened the fence (rather than toggling on either) keeps a ~~~ shown
  // as an example inside a ```` block from closing it: 2 headings instead of 3
  // on fixtures/nested.md.
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = lines[i].match(/^(#{1,3})\s+(.+)/);
    if (m) nodes.push({ kind: `h${m[1].length}`, name: m[2].trim(), startLine: i + 1, children: [] });
  }
  return nodes;
}

/** Total nodes in a tree, at any depth. */
function countNodes(nodes: OutlineNode[]): number {
  return nodes.reduce((n, c) => n + 1 + countNodes(c.children), 0);
}

interface OutlineOpts { maxRows?: number; offset?: number; depth?: number }

function buildOutline(filePath: string, opts: OutlineOpts = {}): { language: string; totalLines: number; nodes: OutlineNode[]; rendered: string } {
  const lines = readLines(filePath);
  const lang = detectLanguage(filePath);
  let nodes: OutlineNode[] = [];

  if (lang === "Python") nodes = outlinePython(lines);
  else if (lang === "JavaScript" || lang === "TypeScript") nodes = outlineJS(lines);
  else if (lang === "Markdown") nodes = outlineMarkdown(lines);

  const parts = [`${path.basename(filePath)}  (${lines.length} lines, ${lang})`];

  // An outline is an INDEX, so it is paginated rather than truncated by
  // characters: cutting an index mid-way produces a false negative the caller
  // cannot detect — it does not see a symbol and concludes the symbol does not
  // exist, having been told it holds the map. Every response therefore says how
  // many rows exist and how to ask for the rest.
  const total = countNodes(nodes);
  const maxRows = opts.maxRows ?? 200;
  const offset = Math.max(0, opts.offset ?? 0);
  const maxDepth = opts.depth ?? Infinity;
  let seen = 0;
  let shown = 0;

  const render = (list: OutlineNode[], indent: string, depth: number) => {
    list.forEach((n, i) => {
      const isLast = i === list.length - 1;
      const hidden = depth + 1 > maxDepth && n.children.length > 0;
      if (seen >= offset && shown < maxRows) {
        const end = n.endLine ? `–${n.endLine}` : "";
        const members = hidden ? `  (${countNodes(n.children)} members)` : "";
        parts.push(`${indent}${isLast ? "└──" : "├──"} ${n.kind} ${n.name}  lines ${n.startLine}${end}${members}`);
        shown++;
      }
      seen++;
      if (!hidden && n.children.length > 0) render(n.children, `${indent}${isLast ? "    " : "│   "}`, depth + 1);
    });
  };
  render(nodes, "", 1);

  if (offset > 0 || shown < total) {
    const last = offset + shown;
    parts.push("", last < total
      ? `[showing ${shown} of ${total} symbols (rows ${offset + 1}–${last}) — call file_outline with offset=${last} for the rest]`
      : `[showing ${shown} of ${total} symbols (rows ${offset + 1}–${last})]`);
  }

  const note = parserNote(lang, nodes.length);
  if (note) parts.push("", note);

  return { language: lang, totalLines: lines.length, nodes, rendered: parts.join("\n") };
}

function chunkLines(filePath: string, start: number, end: number): string {
  const lines = readLines(filePath);
  const s = Math.max(1, start);
  const e = Math.min(lines.length, end);
  const selected = lines.slice(s - 1, e);
  // Now that the phantom trailing line is gone, an entirely out-of-range request
  // (chunk(1,10) on a 0-byte file, chunk(2687,2700) on sessions.py) returns
  // nothing at all. Say so, rather than answer an empty string that reads like
  // a blank line of real content.
  if (selected.length === 0) return `(no lines: file has ${lines.length}, requested ${start}–${end})`;
  return selected
    .map((line, i) => `${String(s + i).padStart(5)} │ ${line}`)
    .join("\n");
}

interface SearchMatch {
  lineNumber: number;
  line: string;
  contextBefore: string[];
  contextAfter: string[];
  rendered: string;
}

interface SearchResult {
  matches: SearchMatch[];
  /** Lines that matched anywhere in the file, not just the ones returned. */
  occurrences: number;
  /** How many emitted lines were shortened to MAX_LINE_CHARS. */
  trimmed: number;
}

/** Per emitted line. A minified bundle is one 1.2M-char line; one match should not ship it. */
const MAX_LINE_CHARS = 800;
/** Longer than this is not a search, and complexity scales with length. */
const MAX_QUERY_CHARS = 200;

/**
 * Reject the catastrophic-backtracking shapes before running a caller's regex.
 *
 * `useRegex: true` hands an agent-authored pattern straight to the engine. On
 * `(a+)+$` the cost is exponential in the length of the *subject*: measured
 * 498ms at 22 chars, 1,170ms at 26, 4,829ms at 28. Two things make that worse
 * than it reads. Blowup happens on lines that do NOT match, so `matches.length`
 * never rises and no result cap can end the loop — the cost is per line, times
 * every line in the file. And this server is stdio and single-threaded, so the
 * whole thing wedges with no way to cancel from the protocol. A timeout cannot
 * help: the hang is inside a synchronous call that never yields.
 *
 * This is a heuristic, not a decision procedure. It catches a quantified group
 * whose body is itself quantified — the classic family — and deliberately does
 * not try to catch overlapping alternation like `(a|a)*`. The length cap is the
 * backstop for what it misses.
 */
function unsafePattern(src: string): string | null {
  if (src.length > MAX_QUERY_CHARS) return `pattern is ${src.length} chars (limit ${MAX_QUERY_CHARS})`;
  const groupHasQuantifier: boolean[] = [];
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "(") { groupHasQuantifier.push(false); continue; }
    if (c === ")") {
      const bodyQuantified = groupHasQuantifier.pop() ?? false;
      const next = src[i + 1];
      if (bodyQuantified && (next === "*" || next === "+" || next === "{")) {
        return `nested quantifier near position ${i} — a repeated group whose body also repeats backtracks exponentially`;
      }
      if (groupHasQuantifier.length > 0 && (bodyQuantified || next === "*" || next === "+" || next === "{")) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }
      continue;
    }
    if ((c === "*" || c === "+" || c === "{") && groupHasQuantifier.length > 0) {
      groupHasQuantifier[groupHasQuantifier.length - 1] = true;
    }
  }
  return null;
}

/** Shorten a long line around the match, so the window keeps the hit visible. */
function trimAroundMatch(line: string, pattern: RegExp): { text: string; trimmed: boolean } {
  if (line.length <= MAX_LINE_CHARS) return { text: line, trimmed: false };
  const at = line.search(pattern);
  const from = Math.max(0, (at === -1 ? 0 : at) - Math.floor(MAX_LINE_CHARS / 2));
  return {
    text: line.slice(from, from + MAX_LINE_CHARS) +
      `  [line trimmed to ${MAX_LINE_CHARS} of ${line.length} chars${at === -1 ? "" : `, match at col ${at + 1}`}]`,
    trimmed: true,
  };
}

function searchFile(filePath: string, query: string, contextLines: number, maxResults: number, useRegex: boolean): SearchResult {
  const lines = readLines(filePath);
  let pattern: RegExp;
  if (useRegex) {
    const unsafe = unsafePattern(query);
    if (unsafe) throw new Error(`Refusing this regex: ${unsafe}. Search without useRegex, or simplify the pattern.`);
    try {
      pattern = new RegExp(query, "i");
    } catch (e) {
      throw new Error(`Invalid regex ${JSON.stringify(query)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  const matches: SearchMatch[] = [];
  let occurrences = 0;
  let trimmed = 0;

  // Every line is scanned even once maxResults is reached, so `occurrences` is
  // the file's real total. Reporting matches.length as the total let 20 mean
  // "20, and that is all there is" when it meant "20, and the cap stopped me".
  for (let i = 0; i < lines.length; i++) {
    if (!pattern.test(lines[i])) continue;
    occurrences++;
    if (matches.length >= maxResults) continue;

    const before = lines.slice(Math.max(0, i - contextLines), i);
    const after = lines.slice(i + 1, Math.min(lines.length, i + contextLines + 1));

    const parts: string[] = [];
    before.forEach((l, j) => {
      const t = trimAroundMatch(l, pattern);
      if (t.trimmed) trimmed++;
      parts.push(`  ${String(i - before.length + j + 1).padStart(5)} │ ${t.text}`);
    });
    const hit = trimAroundMatch(lines[i], pattern);
    if (hit.trimmed) trimmed++;
    parts.push(`▶ ${String(i + 1).padStart(5)} │ ${hit.text}`);
    after.forEach((l, j) => {
      const t = trimAroundMatch(l, pattern);
      if (t.trimmed) trimmed++;
      parts.push(`  ${String(i + 2 + j).padStart(5)} │ ${t.text}`);
    });

    matches.push({ lineNumber: i + 1, line: lines[i], contextBefore: before, contextAfter: after, rendered: parts.join("\n") });
  }
  return { matches, occurrences, trimmed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

/**
 * file_outline — scan file structure in one call.
 * Use this first. Returns classes, functions, headings + line numbers.
 * Costs almost nothing. Tells you exactly where everything lives.
 */
server.registerTool(
  "file_outline",
  {
    title: "Outline a file",
    annotations: {
      title: "Outline a file",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: "Scan a file's structure: classes, functions, headings with line numbers. Always call this first before reading content. Returns a tree-style outline so you know exactly where everything lives before fetching any chunk.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or relative path to the file"),
      maxRows: z.number().int().positive().optional().default(200).describe("Max symbol rows to return (default 200)"),
      offset: z.number().int().nonnegative().optional().default(0).describe("Skip this many rows — use the offset the previous response reported"),
      depth: z.number().int().positive().optional().describe("Only show this many levels; deeper members are summarised as a count"),
    }),
  },
  async ({ path: filePath, maxRows, offset, depth }) => {
    try {
      const outline = buildOutline(filePath, { maxRows, offset, depth });
      const text = [
        `FILE: ${path.basename(filePath)}`,
        `LANGUAGE: ${outline.language}`,
        `TOTAL LINES: ${outline.totalLines}`,
        "",
        outline.rendered,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }
);

/**
 * file_search — find something in a file with context.
 * Use when you know what you want but not where it is.
 * Returns matching lines with surrounding context and line numbers.
 */
server.registerTool(
  "file_search",
  {
    title: "Search within a file",
    annotations: {
      title: "Search within a file",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: "Search a file for a keyword or regex pattern. Returns matching lines with surrounding context and exact line numbers. Use when you know what you're looking for but not where it is. Follow up with file_chunk to read the full section.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or relative path to the file"),
      query: z.string().describe("Keyword or regex pattern to search for"),
      contextLines: z.number().optional().default(5).describe("Lines of context around each match (default 5)"),
      maxResults: z.number().optional().default(20).describe("Max number of matches to return (default 20)"),
      useRegex: z.boolean().optional().default(false).describe("Treat query as a regex pattern"),
    }),
  },
  async ({ path: filePath, query, contextLines, maxResults, useRegex }) => {
    try {
      const cap = maxResults ?? 20;
      const { matches, occurrences, trimmed } = searchFile(filePath, query, contextLines ?? 5, cap, useRegex ?? false);
      if (matches.length === 0) {
        return { content: [{ type: "text" as const, text: `No matches found for "${query}" in ${filePath}` }] };
      }
      const text = matches.map((m, i) => `Match ${i + 1} (line ${m.lineNumber}):\n${m.rendered}`).join("\n\n---\n\n");
      // Say when the cap hid results. "20 match(es)" read as the file's total.
      const header = occurrences > matches.length
        ? `${matches.length} of ${occurrences} matching line(s) for "${query}" — raise maxResults to see the rest`
        : `${occurrences} matching line(s) for "${query}"`;
      const note = trimmed > 0 ? ` (${trimmed} long line(s) trimmed to ${MAX_LINE_CHARS} chars)` : "";
      return { content: [{ type: "text" as const, text: `${header}${note}:\n\n${text}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }
);

/**
 * file_chunk — read a precise line range.
 * Use after file_outline or file_search tells you which lines to read.
 */
server.registerTool(
  "file_chunk",
  {
    title: "Read a line range",
    annotations: {
      title: "Read a line range",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: "Read a precise line range from a file, with line numbers. Use after file_outline or file_search tells you exactly which lines you need. Lines are 1-indexed and inclusive.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or relative path to the file"),
      start: z.number().describe("First line to read (1-indexed)"),
      end: z.number().describe("Last line to read (inclusive)"),
    }),
  },
  async ({ path: filePath, start, end }) => {
    try {
      const text = chunkLines(filePath, start, end);
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }
);

/**
 * file_summarize — outline + head + tail in one call.
 * Use when you've never seen a file before.
 */
server.registerTool(
  "file_summarize",
  {
    title: "Summarize a file",
    annotations: {
      title: "Summarize a file",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: "Get a full picture of a file in one call: structure outline + first 40 lines + last 20 lines. No LLM required. Use when you've never seen a file before and need to decide which part to read next.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or relative path to the file"),
      headLines: z.number().optional().default(40).describe("Number of lines from the top to include (default 40)"),
      tailLines: z.number().optional().default(20).describe("Number of lines from the bottom to include (default 20)"),
    }),
  },
  async ({ path: filePath, headLines, tailLines }) => {
    try {
      const lines = readLines(filePath);
      const outline = buildOutline(filePath);
      const head = lines.slice(0, headLines ?? 40).map((l, i) => `${String(i + 1).padStart(5)} │ ${l}`).join("\n");
      const tailStart = Math.max((headLines ?? 40), lines.length - (tailLines ?? 20));
      const tail = lines.slice(tailStart).map((l, i) => `${String(tailStart + i + 1).padStart(5)} │ ${l}`).join("\n");

      const text = [
        `FILE: ${path.basename(filePath)}`,
        `LANGUAGE: ${outline.language}`,
        `SIZE: ${outline.totalLines} lines`,
        "",
        "STRUCTURE:",
        outline.rendered,
        "",
        `HEAD (lines 1–${headLines ?? 40}):`,
        head,
        ...(tailStart < lines.length ? ["", `TAIL (lines ${tailStart + 1}–${lines.length}):`, tail] : []),
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }
);

/**
 * file_fetch — outline + targeted chunk in ONE call.
 * The power tool. Give it a file and a target (function name, class name,
 * or keyword) and it returns the outline PLUS the exact matching chunk.
 * Collapses what would be 3–4 tool calls into 1.
 */
server.registerTool(
  "file_fetch",
  {
    title: "Fetch a symbol",
    annotations: {
      title: "Fetch a symbol",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: "Fetch a symbol by name in one call: resolves the name against the file's structure and returns that definition's exact line range and body. Falls back to a text search when the name matches no symbol. Use when you know what you want to read — this replaces outline→find the line→chunk.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or relative path to the file"),
      target: z.string().describe("A symbol name (function, class, method, heading) — or any keyword, which falls back to text search"),
      contextLines: z.number().optional().default(10).describe("Lines of context around each match, search fallback only (default 10)"),
      maxLines: z.number().optional().default(250).describe("Max body lines to return for a resolved symbol (default 250)"),
    }),
  },
  async ({ path: filePath, target, contextLines, maxLines }) => {
    try {
      const outline = buildOutline(filePath);
      const header = `FILE: ${path.basename(filePath)}  (${outline.totalLines} lines, ${outline.language})`;

      // Resolve the name against the structure first. The old behaviour printed
      // the ENTIRE outline on every call and then grep'd for the target, so
      // asking for one function returned the whole map plus every call site and
      // docstring mention: 24,980 chars where a plain search answered the same
      // question in 1,195. Exact ranges exist now, so a name can be addressed
      // instead of searched.
      const flat = outline.nodes.flatMap(n => [n, ...n.children]);
      const hits = flat.filter(n => n.name.toLowerCase() === target.toLowerCase());

      if (hits.length > 1) {
        const SHOW = 20;
        const rows = hits.slice(0, SHOW).map(h => `  ${h.kind} ${h.name}  lines ${h.startLine}${h.endLine ? `–${h.endLine}` : ""}`);
        if (hits.length > SHOW) rows.push(`  … ${hits.length - SHOW} more — narrow the target or use file_outline`);
        return { content: [{ type: "text" as const, text:
          [header, "", `"${target}" matches ${hits.length} symbols — fetch one with file_chunk:`, ...rows].join("\n") }] };
      }

      if (hits.length === 1 && hits[0].endLine) {
        const n = hits[0];
        const span = n.endLine! - n.startLine + 1;
        const cap = maxLines ?? 250;
        const last = Math.min(n.endLine!, n.startLine + cap - 1);
        const body = chunkLines(filePath, n.startLine, last);
        const parts = [
          header,
          `SYMBOL: ${n.kind} ${n.name}  lines ${n.startLine}–${n.endLine}  (${span} lines)`,
          "",
          body,
        ];
        if (last < n.endLine!) {
          parts.push("", `[showing ${cap} of ${span} lines — continue with file_chunk(start=${last + 1}, end=${n.endLine})]`);
        }
        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      }

      // No symbol by that name: fall back to search, and include the structure
      // here — this is the one case where the agent still needs the map.
      const { matches, occurrences } = searchFile(filePath, target, contextLines ?? 10, 5, false);
      const parts = [header, "", "STRUCTURE:", outline.rendered];
      if (matches.length > 0) {
        parts.push("", `"${target}" is not a symbol in this file; ${occurrences} matching line(s) as text:`);
        matches.forEach((m, i) => parts.push(`\nMatch ${i + 1} (line ${m.lineNumber}):\n${m.rendered}`));
        if (occurrences > matches.length) parts.push(`\n[${matches.length} of ${occurrences} shown — use file_search with maxResults for the rest]`);
      } else {
        parts.push("", `No symbol or text match for "${target}"`);
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("filelens MCP server running on stdio");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
