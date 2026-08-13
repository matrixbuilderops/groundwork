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

const server = new McpServer({ name: "filelens", version: "0.1.0" });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function readLines(filePath: string): string[] {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  return fs.readFileSync(resolved, "utf-8").split("\n");
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".py": "Python", ".js": "JavaScript", ".ts": "TypeScript",
    ".tsx": "TypeScript", ".jsx": "JavaScript", ".md": "Markdown",
    ".go": "Go", ".rs": "Rust", ".java": "Java", ".rb": "Ruby",
    ".sh": "Shell", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML",
    ".toml": "TOML", ".html": "HTML", ".css": "CSS", ".cpp": "C++",
    ".c": "C", ".cs": "C#",
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

function outlinePython(lines: string[]): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  let currentClass: OutlineNode | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const classMatch = line.match(/^class\s+(\w+)/);
    if (classMatch) {
      if (currentClass) currentClass.endLine = lineNum - 1;
      currentClass = { kind: "class", name: classMatch[1], startLine: lineNum, children: [] };
      nodes.push(currentClass);
      continue;
    }

    const fnMatch = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)/);
    if (fnMatch) {
      const indent = fnMatch[1].length;
      const name = fnMatch[2];
      const node: OutlineNode = { kind: "def", name, startLine: lineNum, children: [] };
      if (indent > 0 && currentClass) {
        currentClass.children.push(node);
      } else {
        if (currentClass) { currentClass.endLine = lineNum - 1; currentClass = null; }
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
    [/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/, "arrow fn"],
    [/^\s{2,}(?:async\s+)?(\w+)\s*\(/, "method"],
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const [pattern, kind] of patterns) {
      const m = lines[i].match(pattern);
      if (m) { nodes.push({ kind, name: m[1], startLine: i + 1, children: [] }); break; }
    }
  }
  return nodes;
}

function outlineMarkdown(lines: string[]): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  for (let i = 0; i < lines.length; i++) {
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
      parts.push(`${cp} ${c.name}()  line ${c.startLine}${ce}`);
    }
  }

  return { language: lang, totalLines: lines.length, nodes, rendered: parts.join("\n") };
}

function chunkLines(filePath: string, start: number, end: number): string {
  const lines = readLines(filePath);
  const s = Math.max(1, start);
  const e = Math.min(lines.length, end);
  return lines.slice(s - 1, e)
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
