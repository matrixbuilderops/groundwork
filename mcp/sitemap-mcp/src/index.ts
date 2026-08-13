#!/usr/bin/env node
/**
 * SiteMap MCP Server
 *
 * Collapses website exploration into single structured results.
 * Designed for AI agents that already have HTTP tools but want to
 * reduce round trips by getting page structure + content in one shot.
 *
 * Tools exposed:
 *   site_fetch_page     — fetch one page, return clean text (no HTML noise)
 *   site_outline        — crawl site links/structure without fetching all content
 *   site_search_page    — fetch a page + search it for a term in one call
 *   site_awareness      — full site map: pages, forms, actions, API hints
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "sitemap", version: "0.1.0" });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchHTML(url: string, timeoutMs = 10000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; groundwork-sitemap/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Strip HTML tags and collapse whitespace into readable plain text */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

/** Extract page title */
function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (m) return m[1].trim();
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  return h1 ? h1[1].trim() : "Untitled";
}

/** Extract all same-origin links from HTML */
function extractLinks(html: string, baseUrl: string): string[] {
  const origin = new URL(baseUrl).origin;
  const links: Set<string> = new Set();
  const re = /href=["']([^"'#?][^"']*?)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl).href;
      if (abs.startsWith(origin)) links.add(abs);
    } catch { /* skip malformed */ }
  }
  return [...links];
}

/** Extract forms from HTML */
function extractForms(html: string, pageUrl: string): Array<{ page: string; fields: string[]; action: string; method: string }> {
  const forms: Array<{ page: string; fields: string[]; action: string; method: string }> = [];
  const formRe = /<form([^>]*)>([\s\S]*?)<\/form>/gi;
  let fm: RegExpExecArray | null;
  while ((fm = formRe.exec(html)) !== null) {
    const attrs = fm[1];
    const body = fm[2];
    const action = (attrs.match(/action=["']([^"']+)["']/i)?.[1] ?? pageUrl);
    const method = (attrs.match(/method=["']([^"']+)["']/i)?.[1] ?? "GET").toUpperCase();
    const fields: string[] = [];
    const inputRe = /(?:name|id|placeholder)=["']([^"']+)["']/gi;
    let im: RegExpExecArray | null;
    while ((im = inputRe.exec(body)) !== null) {
      if (!fields.includes(im[1])) fields.push(im[1]);
    }
    if (fields.length > 0) forms.push({ page: pageUrl, fields, action: `${method} ${action}`, method });
  }
  return forms;
}

/** Detect API endpoint hints in HTML/JS */
function extractApiHints(html: string): string[] {
  const hints: Set<string> = new Set();
  const re = /["'](\/api\/[a-zA-Z0-9/_-]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) hints.add(m[1].split("?")[0]);
  return [...hints].sort();
}

/** Check if page likely requires auth */
function requiresAuth(text: string): boolean {
  const lower = text.toLowerCase();
  return ["log in", "login", "sign in", "signin", "please authenticate", "unauthorized", "401"].some(s => lower.includes(s));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

/**
 * site_fetch_page — fetch one URL, return clean readable text.
 * Strips navbars, scripts, footers. No HTML noise.
 */
server.registerTool(
  "site_fetch_page",
  {
    description: "Fetch a URL and return clean readable text — no HTML tags, no scripts, no navbars. Strips all noise and returns just the content. Use instead of curl+grep when you want readable page content in one call.",
    inputSchema: z.object({
      url: z.string().url().describe("The URL to fetch"),
      maxChars: z.number().optional().default(8000).describe("Max characters to return (default 8000). Use to stay within context limits."),
    }),
  },
  async ({ url, maxChars }) => {
    try {
      const html = await fetchHTML(url);
      const title = extractTitle(html);
      const text = htmlToText(html);
      const trimmed = text.slice(0, maxChars ?? 8000);
      const truncated = text.length > (maxChars ?? 8000) ? `\n\n[... truncated at ${maxChars} chars. Use maxChars to increase.]` : "";
      return { content: [{ type: "text" as const, text: `URL: ${url}\nTITLE: ${title}\n\n${trimmed}${truncated}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error fetching ${url}: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }
);

/**
 * site_outline — discover what pages and routes exist on a site.
 * Fetches the root page and extracts all same-origin links.
 * Returns a structured map without fetching every page.
 */
server.registerTool(
  "site_outline",
  {
    description: "Discover what pages and routes exist on a site. Fetches the root page and extracts all same-origin links, forms, and API hints — without fetching every page. Returns a structured map so you know what's available before deciding what to read.",
    inputSchema: z.object({
      url: z.string().url().describe("The base URL of the site (e.g. https://example.com)"),
    }),
  },
  async ({ url }) => {
    try {
      const html = await fetchHTML(url);
      const title = extractTitle(html);
      const links = extractLinks(html, url);
      const forms = extractForms(html, url);
      const apiHints = extractApiHints(html);
      const authRequired = requiresAuth(htmlToText(html));

      const parts = [
        `SITE: ${url}`,
        `TITLE: ${title}`,
        `AUTH REQUIRED: ${authRequired}`,
        "",
        `DISCOVERED LINKS (${links.length}):`,
        ...links.map(l => `  ${l}`),
      ];

      if (forms.length > 0) {
        parts.push("", `FORMS (${forms.length}):`);
        forms.forEach(f => parts.push(`  ${f.action}  fields: [${f.fields.join(", ")}]`));
      }

      if (apiHints.length > 0) {
        parts.push("", `API HINTS (${apiHints.length}):`, ...apiHints.map(h => `  ${h}`));
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }
);

/**
 * site_search_page — fetch a page AND search it for a term in one call.
 * The key power tool. Replaces: fetch → read → grep → read section.
 */
server.registerTool(
  "site_search_page",
  {
    description: "Fetch a URL and search it for a term in one call. Returns only the matching paragraphs/sections, not the whole page. Use when you want to know if/where a specific topic appears on a page without reading the whole thing. Replaces fetch+grep with a single call.",
    inputSchema: z.object({
      url: z.string().url().describe("The URL to fetch and search"),
      query: z.string().describe("The term or phrase to search for"),
      contextSentences: z.number().optional().default(3).describe("Sentences of context around each match (default 3)"),
    }),
  },
  async ({ url, query, contextSentences }) => {
    try {
      const html = await fetchHTML(url);
      const title = extractTitle(html);
      const text = htmlToText(html);

      // Split into sentences, find matches with context
      const sentences = text.split(/(?<=[.!?])\s+/);
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const ctx = contextSentences ?? 3;

      const matches: string[] = [];
      for (let i = 0; i < sentences.length; i++) {
        if (pattern.test(sentences[i])) {
          const start = Math.max(0, i - ctx);
          const end = Math.min(sentences.length, i + ctx + 1);
          const block = sentences.slice(start, end).join(" ");
          if (!matches.includes(block)) matches.push(block);
        }
      }

      if (matches.length === 0) {
        return { content: [{ type: "text" as const, text: `No matches for "${query}" on ${url}\nTITLE: ${title}` }] };
      }

      const result = [
        `URL: ${url}`,
        `TITLE: ${title}`,
        `MATCHES FOR "${query}" (${matches.length}):`,
        "",
        matches.map((m, i) => `[${i + 1}] ...${m}...`).join("\n\n"),
      ].join("\n");

      return { content: [{ type: "text" as const, text: result }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }
);

/**
 * site_awareness — full structured map of a site.
 * Crawls up to maxPages, returns pages + forms + actions + API hints.
 * The full SiteMap in one call — use when you need to understand an
 * entire site before deciding what to do.
 */
server.registerTool(
  "site_awareness",
  {
    description: "Build a full structured map of a site in one call: every discovered page with title+summary, every form with fields+endpoint, every API hint. Returns a Site Awareness Object the AI can navigate programmatically. Use when you need to understand an entire site before taking action.",
    inputSchema: z.object({
      url: z.string().url().describe("The base URL of the site"),
      maxPages: z.number().optional().default(10).describe("Max pages to crawl (default 10). Increase for larger sites."),
    }),
  },
  async ({ url, maxPages }) => {
    try {
      const origin = new URL(url).origin;
      const visited: Map<string, { title: string; summary: string; forms: ReturnType<typeof extractForms>; apiHints: string[] }> = new Map();
      const queue: string[] = [url];
      const max = maxPages ?? 10;

      while (queue.length > 0 && visited.size < max) {
        const current = queue.shift()!;
        const currentPath = new URL(current).pathname;
        if (visited.has(currentPath)) continue;

        try {
          const html = await fetchHTML(current, 8000);
          const text = htmlToText(html);
          const title = extractTitle(html);
          const summary = text.slice(0, 200).replace(/\n/g, " ");
          const forms = extractForms(html, current);
          const apiHints = extractApiHints(html);
          visited.set(currentPath, { title, summary, forms, apiHints });

          // Queue new same-origin links
          for (const link of extractLinks(html, current)) {
            const linkPath = new URL(link).pathname;
            if (!visited.has(linkPath) && link.startsWith(origin)) queue.push(link);
          }
        } catch { /* skip failing pages */ }
      }

      const allForms = [...visited.values()].flatMap(v => v.forms);
      const allApiHints = [...new Set([...visited.values()].flatMap(v => v.apiHints))].sort();

      const obj = {
        url,
        pagesScanned: visited.size,
        pages: [...visited.entries()].map(([path, v]) => ({ path, title: v.title, summary: v.summary })),
        forms: allForms,
        apiHints: allApiHints,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
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
  console.error("sitemap MCP server running on stdio");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
