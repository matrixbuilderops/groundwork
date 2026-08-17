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

const server = new McpServer({ name: "filelens", version: "0.3.0" });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function readLines(filePath: string): string[] {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
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

function outlinePython(lines: string[]): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  let currentClass: OutlineNode | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const classMatch = line.match(/^class\s+(\w+)/);
    if (classMatch) {
      currentClass = {
        kind: "class", name: classMatch[1], startLine: lineNum,
        endLine: pythonBlockEnd(lines, i, 0), children: [],
      };
      nodes.push(currentClass);
      continue;
    }

    const fnMatch = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)/);
    if (fnMatch) {
      const indent = fnMatch[1].length;
      const name = fnMatch[2];
      const node: OutlineNode = {
        kind: "def", name, startLine: lineNum,
        endLine: pythonBlockEnd(lines, i, indent), children: [],
      };
      // With a real class end available, a def is a method only when it falls
      // inside the class body. Keying off "indented and a class was seen" put
      // every def after a nested class under the wrong parent — 343 of 15,444
      // stdlib symbols, e.g. argparse's _Section methods filed under
      // HelpFormatter.
      if (indent > 0 && currentClass && lineNum <= currentClass.endLine!) {
        currentClass.children.push(node);
      } else {
        if (currentClass && lineNum > currentClass.endLine!) currentClass = null;
        nodes.push(node);
      }
    }
  }
  return nodes;
}

function outlineJS(lines: string[]): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  const patterns: [RegExp, string][] = [
    [/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, "function"],
    [/^(?:export\s+)?class\s+(\w+)/, "class"],
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
    [/^\s+(?:async\s+)?(?!(?:if|for|while|switch|catch|do|return|typeof|await|new|function)\b)(\w+)\s*\((?![^)]*\bfunction\b)[^)]*\)\s*(?::[^{;]+)?\s*\{/, "method"],
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
  return nodes;
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

function buildOutline(filePath: string): { language: string; totalLines: number; nodes: OutlineNode[]; rendered: string } {
  const lines = readLines(filePath);
  const lang = detectLanguage(filePath);
  let nodes: OutlineNode[] = [];

  if (lang === "Python") nodes = outlinePython(lines);
  else if (lang === "JavaScript" || lang === "TypeScript") nodes = outlineJS(lines);
  else if (lang === "Markdown") nodes = outlineMarkdown(lines);

  const parts = [`${path.basename(filePath)}  (${lines.length} lines, ${lang})`];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const prefix = i < nodes.length - 1 ? "├──" : "└──";
    const end = n.endLine ? `–${n.endLine}` : "";
    parts.push(`${prefix} ${n.kind} ${n.name}  lines ${n.startLine}${end}`);
    for (let j = 0; j < n.children.length; j++) {
      const c = n.children[j];
      const cp = j < n.children.length - 1 ? "│   ├──" : "│   └──";
      const ce = c.endLine ? `–${c.endLine}` : "";
      parts.push(`${cp} ${c.name}()  lines ${c.startLine}${ce}`);
    }
  }

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

function searchFile(filePath: string, query: string, contextLines: number, maxResults: number, useRegex: boolean): SearchMatch[] {
  const lines = readLines(filePath);
  const pattern = new RegExp(useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const matches: SearchMatch[] = [];

  for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
    if (!pattern.test(lines[i])) continue;
    const before = lines.slice(Math.max(0, i - contextLines), i);
    const after = lines.slice(i + 1, Math.min(lines.length, i + contextLines + 1));

    const parts: string[] = [];
    before.forEach((l, j) => parts.push(`  ${String(i - before.length + j + 1).padStart(5)} │ ${l}`));
    parts.push(`▶ ${String(i + 1).padStart(5)} │ ${lines[i]}`);
    after.forEach((l, j) => parts.push(`  ${String(i + 2 + j).padStart(5)} │ ${l}`));

    matches.push({ lineNumber: i + 1, line: lines[i], contextBefore: before, contextAfter: after, rendered: parts.join("\n") });
  }
  return matches;
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
    description: "Scan a file's structure: classes, functions, headings with line numbers. Always call this first before reading content. Returns a tree-style outline so you know exactly where everything lives before fetching any chunk.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or relative path to the file"),
    }),
  },
  async ({ path: filePath }) => {
    try {
      const outline = buildOutline(filePath);
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
      const matches = searchFile(filePath, query, contextLines ?? 5, maxResults ?? 20, useRegex ?? false);
      if (matches.length === 0) {
        return { content: [{ type: "text" as const, text: `No matches found for "${query}" in ${filePath}` }] };
      }
      const text = matches.map((m, i) => `Match ${i + 1} (line ${m.lineNumber}):\n${m.rendered}`).join("\n\n---\n\n");
      return { content: [{ type: "text" as const, text: `${matches.length} match(es) for "${query}":\n\n${text}` }] };
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
    description: "THE power tool — outline + targeted chunk in one call. Give it a file path and a target (function name, class name, keyword) and get back the full outline AND the exact matching lines. Replaces the outline→search→chunk sequence with a single call. Use this when you know roughly what you want but need both the map and the content in one shot.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or relative path to the file"),
      target: z.string().describe("What you're looking for: function name, class name, keyword, or pattern"),
      contextLines: z.number().optional().default(10).describe("Lines of context around each match (default 10)"),
    }),
  },
  async ({ path: filePath, target, contextLines }) => {
    try {
      const outline = buildOutline(filePath);
      const matches = searchFile(filePath, target, contextLines ?? 10, 5, false);

      const parts = [
        `FILE: ${path.basename(filePath)}  (${outline.totalLines} lines, ${outline.language})`,
        "",
        "STRUCTURE:",
        outline.rendered,
      ];

      if (matches.length > 0) {
        parts.push("", `MATCHES FOR "${target}":`);
        matches.forEach((m, i) => {
          parts.push(`\nMatch ${i + 1} (line ${m.lineNumber}):\n${m.rendered}`);
        });
      } else {
        parts.push("", `No matches found for "${target}"`);
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
