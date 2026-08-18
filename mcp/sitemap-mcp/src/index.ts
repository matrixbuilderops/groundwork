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
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const server = new McpServer({ name: "sitemap", version: "0.3.0" });

// ─────────────────────────────────────────────────────────────────────────────
// Destination policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hosts that are normally blocked but may be allowed explicitly, e.g. for
 * local fixtures: SITEMAP_ALLOW_PRIVATE="1" (blanket) or a comma-separated
 * list of "host" / "host:port" entries. Default is empty — nothing private
 * is reachable.
 */
const ALLOW_PRIVATE_RAW = (process.env.SITEMAP_ALLOW_PRIVATE ?? "").trim();
const ALLOW_PRIVATE_ALL = ALLOW_PRIVATE_RAW === "1" || ALLOW_PRIVATE_RAW.toLowerCase() === "all";
const ALLOW_PRIVATE_HOSTS = new Set(
  ALLOW_PRIVATE_ALL ? [] : ALLOW_PRIVATE_RAW.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
);

/**
 * Which reserved-range rule an address falls under, or null if it is public.
 * Names are returned (not a boolean) so the error can say *why* it was blocked.
 */
function reservedRule(addr: string): string | null {
  const fam = isIP(addr);
  if (fam === 4) {
    const o = addr.split(".").map(Number);
    if (o[0] === 0) return "0.0.0.0/8 (this network)";
    if (o[0] === 10) return "10.0.0.0/8 (private)";
    if (o[0] === 127) return "127.0.0.0/8 (loopback)";
    if (o[0] === 169 && o[1] === 254) return "169.254.0.0/16 (link-local — cloud instance metadata)";
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return "172.16.0.0/12 (private)";
    if (o[0] === 192 && o[1] === 168) return "192.168.0.0/16 (private)";
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return "100.64.0.0/10 (carrier NAT)";
    if (o[0] >= 224) return "224.0.0.0/4+ (multicast/reserved)";
    return null;
  }
  if (fam === 6) {
    const a = addr.toLowerCase();
    // ::ffff:127.0.0.1 and friends carry an embedded v4 address.
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return reservedRule(mapped[1]);
    if (a === "::" || a === "::1") return "::/128, ::1/128 (unspecified/loopback)";
    const head = parseInt(a.split(":")[0] || "0", 16);
    if ((head & 0xfe00) === 0xfc00) return "fc00::/7 (unique local)";
    if ((head & 0xffc0) === 0xfe80) return "fe80::/10 (link-local)";
    return null;
  }
  return null;
}

/**
 * Gate one hop. Throws with the host and the rule that blocked it, so a
 * blocked destination never looks like an empty page.
 */
async function assertAllowedUrl(u: URL): Promise<void> {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Blocked scheme "${u.protocol}" — sitemap only fetches http:// and https:// (data:, file: and friends are refused).`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (ALLOW_PRIVATE_ALL) return;
  if (ALLOW_PRIVATE_HOSTS.has(host) || ALLOW_PRIVATE_HOSTS.has(u.host.toLowerCase())) return;

  let addrs: string[];
  if (isIP(host)) {
    // WHATWG URL already normalises 2130706433 and 0x7f000001 to 127.0.0.1,
    // so the numeric-encoding bypasses land here as plain dotted quads.
    addrs = [host];
  } else {
    try {
      addrs = (await lookup(host, { all: true })).map(a => a.address);
    } catch (e) {
      throw new Error(`Cannot resolve host "${host}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const a of addrs) {
    const rule = reservedRule(a);
    if (rule) {
      throw new Error(
        `Blocked host "${u.host}" — resolves to ${a}, in ${rule}. ` +
        `Set SITEMAP_ALLOW_PRIVATE=${u.host} (or =1 for all) to permit it deliberately.`
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** 5 MiB. Measured: a 200 MiB body drove RSS 44 → 692 MiB through res.text() alone. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** undici's own default is 20 hops; 5 is enough for trailing-slash and www redirects. */
const MAX_REDIRECTS = 5;
/** Per-match ceiling in site_search_page. 800 chars is ~2 paragraphs of prose. */
const MAX_MATCH_CHARS = 800;

/** Read a body with a running byte counter, aborting past MAX_BODY_BYTES. */
async function readCapped(res: Response, url: string): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error(`Response too large: ${url} declares content-length ${declared} B, cap is ${MAX_BODY_BYTES} B (5 MiB).`);
  }
  if (!res.body) return "";
  const decoder = new TextDecoder("utf-8");
  let out = "";
  let seen = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    seen += chunk.byteLength;
    if (seen > MAX_BODY_BYTES) {
      throw new Error(`Response too large: ${url} exceeded the ${MAX_BODY_BYTES} B (5 MiB) cap after ${seen} B — stream aborted, body discarded.`);
    }
    out += decoder.decode(chunk, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * Fetch one page. Redirects are followed by hand so every hop is gated by
 * assertAllowedUrl, and the URL that actually served the body is returned —
 * relative links and the reported provenance both resolve against it.
 */
async function fetchHTML(url: string, timeoutMs = 10000): Promise<{ html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = new URL(url);
    for (let hop = 0; ; hop++) {
      await assertAllowedUrl(current);
      const res = await fetch(current, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; groundwork-sitemap/1.0)" },
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) {
          throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting at ${url}; stopped at ${current.href}`);
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new Error(`HTTP ${res.status} from ${current.href} with unparseable Location: ${location}`);
        }
        current = next;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      // redirect:"manual" leaves res.url as the request URL, so track it ourselves.
      return { html: await readCapped(res, current.href), finalUrl: current.href };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** HTML elements with no closing tag — they can never open a chrome block. */
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"]);

/** Elements that are chrome by tag name alone. */
const CHROME_TAGS = new Set(["script", "style", "noscript", "template", "svg",
  "nav", "header", "footer", "aside"]);

/**
 * Class/id words that mark a container as chrome. Matched as whole
 * hyphen/underscore/space-delimited tokens — a substring test would strip
 * <div class="protocol"> because "protocol" contains "toc".
 */
const CHROME_WORDS = new Set(["nav", "navbar", "navigation", "sidebar", "sidenav",
  "toc", "menu", "breadcrumb", "breadcrumbs", "header", "footer", "masthead", "topbar"]);

/** Whole class names that are chrome regardless of tag. */
const CHROME_CLASS_RE = /\b(back-to-top|skip-to-content|skip-link|screen-reader[\w-]*|sr-only|visually-hidden)\b/i;

function attrValue(attrs: string, name: string): string {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : "";
}

/**
 * Content elements never classify as chrome by class/id, whatever they are
 * called. Measured: www.iana.org/help/example-domains wraps the whole page in
 * <article class="hemmed sidenav">, where "sidenav" is a layout modifier —
 * matching it dropped 100% of the body text.
 */
const NEVER_BY_CLASS = new Set(["article", "main", "body", "html"]);

function isChrome(tag: string, attrs: string): boolean {
  if (CHROME_TAGS.has(tag)) return true;
  if (NEVER_BY_CLASS.has(tag)) return false;
  if (/\brole\s*=\s*["']?(navigation|banner|contentinfo|search|complementary)\b/i.test(attrs)) return true;
  if (/\baria-hidden\s*=\s*["']?true\b/i.test(attrs)) return true;
  const ident = `${attrValue(attrs, "class")} ${attrValue(attrs, "id")}`;
  if (CHROME_CLASS_RE.test(ident)) return true;
  return ident.toLowerCase().split(/[\s_\-]+/).some(w => CHROME_WORDS.has(w));
}

/**
 * Remove chrome elements including everything nested inside them.
 *
 * The old implementation used /<nav[\s\S]*?<\/nav>/gi, which stops at the
 * FIRST </nav>: on <nav><nav>INNER</nav>OUTER_LEAK</nav> it kept OUTER_LEAK.
 * This walks tags with a depth counter instead. An element that never closes
 * is left in place and named in `unclosed` rather than swallowing the tail.
 */
function stripChrome(html: string): { html: string; removed: number; unclosed: string[]; kept: number } {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
  const cuts: Array<[number, number]> = [];
  const unclosed: string[] = [];
  let kept = 0;
  let drop: { tag: string; start: number; depth: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3];
    const selfClosing = VOID_TAGS.has(tag) || /\/\s*$/.test(attrs);
    if (drop) {
      if (tag !== drop.tag) continue;
      if (closing) {
        if (--drop.depth === 0) {
          // Never let a chrome wrapper swallow the document's main content.
          // <h1> counts as main content too: sites routinely put the page's
          // one real headline and its lead paragraph inside <header>, and
          // dropping the block took the headline with it.
          const slice = html.slice(drop.start, tagRe.lastIndex);
          if (/<(main|article|h1)\b/i.test(slice)) kept++;
          else cuts.push([drop.start, tagRe.lastIndex]);
          drop = null;
        }
      } else if (!selfClosing) {
        drop.depth++;
      }
      continue;
    }
    if (closing || selfClosing) continue;
    if (isChrome(tag, attrs)) drop = { tag, start: m.index, depth: 1 };
  }
  if (drop) unclosed.push(drop.tag);

  let out = "";
  let cursor = 0;
  for (const [a, b] of cuts) {
    out += html.slice(cursor, a);
    cursor = b;
  }
  out += html.slice(cursor);
  return { html: out, removed: cuts.length, unclosed, kept };
}

/**
 * Strip HTML tags and collapse whitespace into readable plain text, plus a
 * note when a chrome element could not be closed — its content is still in
 * the output, and silently returning it would look identical to a clean page.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", bull: "•", middot: "·",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", deg: "°", plusmn: "±",
  times: "×", divide: "÷", euro: "€", pound: "£",
  yen: "¥", cent: "¢", sect: "§", para: "¶",
  dagger: "†", prime: "′", frac12: "½", frac14: "¼",
  frac34: "¾", ensp: " ", emsp: " ", thinsp: " ", shy: "",
};

/**
 * Only &amp; &lt; &gt; &nbsp; &quot; and &#39; were decoded, so every other
 * entity reached the agent as source text: a page reading "Caf&#233; &copy;
 * 2026 &mdash; 5" came back with those six characters intact and the rest raw.
 * Decoding in one pass matters — chained .replace() calls turn the literal
 * "&amp;lt;" into "<" by decoding the ampersand and then re-reading its output.
 */
function decodeEntities(s: string): string {
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function tagsToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

function htmlToTextNoted(html: string): { text: string; note: string } {
  const stripped = stripChrome(html);
  const text = tagsToText(stripped.html);
  const note = stripped.unclosed.length
    ? `NOTE: <${stripped.unclosed.join(">, <")}> is never closed in the source — its navigation text was NOT stripped and appears below.\n`
    : "";
  return { text, note };
}

/** Strip HTML tags and collapse whitespace into readable plain text */
function htmlToText(html: string): string {
  return htmlToTextNoted(html).text;
}

/**
 * Fit header+body into `budget` characters *including* the truncation notice.
 * The old slice bounded the body only, so a budget of 8000 returned 8116 and
 * a budget of 1200 returned 1327. The notice length depends on the numbers it
 * prints, so the keep length is solved by fixed point (converges in <= 2 passes).
 */
function fitToBudget(header: string, text: string, budget: number): string {
  const note = (shown: number) => `\n\n[... truncated: ${shown} of ${text.length} chars shown. Use maxChars to increase.]`;
  if (header.length + text.length <= budget) return header + text;
  let keep = Math.max(0, budget - header.length);
  for (let i = 0; i < 4; i++) {
    const next = Math.max(0, budget - header.length - note(Math.min(keep, text.length)).length);
    if (next === keep) break;
    keep = next;
  }
  // Floor: the header always ships, even at an unusably small budget — dropping
  // the provenance line to satisfy maxChars would be the worse answer.
  return header + text.slice(0, keep) + note(keep);
}

/**
 * True when the body came from somewhere other than the URL asked for.
 * Compares normalised hrefs, so "https://example.com" -> "https://example.com/"
 * (WHATWG normalisation, not a redirect) does not print a REQUESTED line.
 */
function redirected(requested: string, finalUrl: string): boolean {
  try { return new URL(requested).href !== finalUrl; } catch { return true; }
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
  // The old class `[^"'#?]` rejected any href whose FIRST character was # or ?,
  // which threw away the page author's own table of contents — the highest-
  // signal structure on a docs page — along with every `?page=2` pagination
  // link. Fragments are kept as same-page anchors and reported separately, so
  // they inform the reader without being queued as pages to fetch.
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (raw === "" || /^(javascript|mailto|tel|data):/i.test(raw)) continue;
    try {
      const abs = new URL(raw, baseUrl);
      // startsWith let https://example.com match https://example.com.cdn.net.
      if (abs.origin === origin) links.add(abs.href);
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
    // One identifier per control, not every name|id|placeholder anywhere in the
    // form body — that reported a <label>'s id, a <div>'s id, and the same
    // input twice (once by name, once by placeholder). The Python twin
    // (parser.py:20-23) already iterated controls; this matches it.
    const controlRe = /<(input|select|textarea)\b((?:"[^"]*"|'[^']*'|[^>])*)>/gi;
    let im: RegExpExecArray | null;
    while ((im = controlRe.exec(body)) !== null) {
      const cattrs = im[2];
      if (/\btype\s*=\s*["']?hidden\b/i.test(cattrs)) continue;
      const name = attrValue(cattrs, "name") || attrValue(cattrs, "id");
      if (name && !fields.includes(name)) fields.push(name);
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
/**
 * Bare substring tests fired on ordinary prose: "401" matched "Room P401
 * schedule" and "price $401", and "login" matched "logins" in a sentence about
 * anything. Word boundaries keep the signal and drop those.
 */
const AUTH_SIGNALS = [
  /\blog\s?in\b/i, /\bsign\s?in\b/i, /\bsign\s?up\b/i,
  /\bplease authenticate\b/i, /\bauthentication required\b/i,
  /\bunauthorized\b/i, /\baccess denied\b/i,
  /\b401\b\s*(?:error|unauthorized|forbidden)?/i,
];

function requiresAuth(text: string): boolean {
  // A bare `401` is only a signal next to auth language, not on its own.
  return AUTH_SIGNALS.slice(0, -1).some(re => re.test(text)) ||
    /\b401\b\s*(?:error|unauthorized|forbidden)|(?:error|status)\s*:?\s*\b401\b/i.test(text);
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
    title: "Fetch a page as text",
    annotations: {
      title: "Fetch a page as text",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description: "Fetch a URL and return clean readable text — no HTML tags, no scripts, no navbars. Strips all noise and returns just the content. Use instead of curl+grep when you want readable page content in one call.",
    inputSchema: z.object({
      url: z.string().url().describe("The URL to fetch"),
      maxChars: z.number().int().positive().optional().default(8000).describe("Max characters in the whole response, header included (default 8000). Use to stay within context limits."),
    }),
  },
  async ({ url, maxChars }) => {
    try {
      const { html, finalUrl } = await fetchHTML(url);
      const title = extractTitle(html);
      const { text, note } = htmlToTextNoted(html);
      const budget = maxChars ?? 8000;
      // URL: line reports what served the body, not what was asked for — a
      // 302 used to stamp the redirect target's content with the caller's URL.
      const header = `URL: ${finalUrl}${redirected(url, finalUrl) ? `\nREQUESTED: ${url}` : ""}\nTITLE: ${title}\n${note}\n`;
      return { content: [{ type: "text" as const, text: fitToBudget(header, text, budget) }] };
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
    title: "Outline a site",
    annotations: {
      title: "Outline a site",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description: "Discover what pages and routes exist on a site. Fetches the root page and extracts all same-origin links, forms, and API hints — without fetching every page. Returns a structured map so you know what's available before deciding what to read.",
    inputSchema: z.object({
      url: z.string().url().describe("The base URL of the site (e.g. https://example.com)"),
      maxChars: z.number().int().positive().optional().default(8000).describe("Max characters to return (default 8000)"),
    }),
  },
  async ({ url, maxChars }) => {
    try {
      const { html, finalUrl } = await fetchHTML(url);
      const title = extractTitle(html);
      // Resolve against the URL that served the body: /docs → /docs/ used to
      // yield /intro (404) instead of /docs/intro (200).
      const links = extractLinks(html, finalUrl);
      const forms = extractForms(html, finalUrl);
      const apiHints = extractApiHints(html);
      // Run the auth heuristic on the UNstripped text: the "Sign in" link
      // usually lives in exactly the header/nav that htmlToText now removes,
      // so feeding it the cleaned text would turn true into false.
      const authRequired = requiresAuth(tagsToText(html));

      // Anchors point inside THIS page; pages are somewhere else. Listing them
      // together made a docs page's own contents indistinguishable from its
      // outbound navigation.
      const here = new URL(finalUrl);
      const anchors: string[] = [];
      const pages: string[] = [];
      for (const l of links) {
        const u = new URL(l);
        if (u.hash && u.pathname === here.pathname && u.search === here.search) anchors.push(u.hash);
        else pages.push(l);
      }

      const head = [
        `SITE: ${finalUrl}`,
        ...(redirected(url, finalUrl) ? [`REQUESTED: ${url}`] : []),
        `TITLE: ${title}`,
        `AUTH REQUIRED: ${authRequired}`,
        "",
      ].join("\n");

      const parts = [`PAGES (${pages.length}):`, ...pages.map(l => `  ${l}`)];

      if (anchors.length > 0) {
        parts.push("", `SECTIONS ON THIS PAGE (${anchors.length}):`, ...anchors.map(a => `  ${a}`));
      }

      if (forms.length > 0) {
        parts.push("", `FORMS (${forms.length}):`);
        forms.forEach(f => parts.push(`  ${f.action}  fields: [${f.fields.join(", ")}]`));
      }

      if (apiHints.length > 0) {
        parts.push("", `API HINTS (${apiHints.length}):`, ...apiHints.map(h => `  ${h}`));
      }

      // fitToBudget was called by site_fetch_page alone; the tool named
      // "outline" would happily emit every one of 4,000 links.
      return { content: [{ type: "text" as const, text: fitToBudget(head, parts.join("\n"), maxChars ?? 8000) }] };
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
    title: "Search a page",
    annotations: {
      title: "Search a page",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description: "Fetch a URL and search it for a term in one call. Returns only the matching paragraphs/sections, not the whole page. Use when you want to know if/where a specific topic appears on a page without reading the whole thing. Replaces fetch+grep with a single call.",
    inputSchema: z.object({
      url: z.string().url().describe("The URL to fetch and search"),
      query: z.string().describe("The term or phrase to search for"),
      contextSentences: z.number().int().nonnegative().optional().default(1).describe("Sentences of context around each match (default 1)"),
    }),
  },
  async ({ url, query, contextSentences }) => {
    try {
      const { html, finalUrl } = await fetchHTML(url);
      const title = extractTitle(html);
      const text = htmlToText(html);

      // Split on block boundaries FIRST. Sentence-splitting alone made one
      // 2,359-char navigation blob a single "sentence" holding 5 of 6 hits,
      // which is how this tool returned 165% of the page it was meant to
      // be a cheaper alternative to. htmlToText emits \n\n at block edges.
      const units = text.split(/\n{2,}/)
        .flatMap(b => b.split(/(?<=[.!?])\s+/))
        .filter(s => s.trim().length > 0);
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(escaped, "i");
      const ctx = contextSentences ?? 1;

      // Report occurrences as well as blocks: 2 blocks used to be the whole
      // answer for a page containing the term 6 times, with no sign of the gap.
      const occurrences = (text.match(new RegExp(escaped, "gi")) ?? []).length;
      const matches: string[] = [];
      let capped = 0;
      for (let i = 0; i < units.length; i++) {
        if (pattern.test(units[i])) {
          const start = Math.max(0, i - ctx);
          const end = Math.min(units.length, i + ctx + 1);
          let block = units.slice(start, end).join(" ");
          if (block.length > MAX_MATCH_CHARS) {
            // Keep the window centred on the hit rather than truncating at 0.
            const at = block.search(pattern);
            const from = Math.max(0, at - MAX_MATCH_CHARS / 2);
            block = block.slice(from, from + MAX_MATCH_CHARS) + ` [block trimmed to ${MAX_MATCH_CHARS} chars]`;
            capped++;
          }
          if (!matches.includes(block)) matches.push(block);
        }
      }

      if (matches.length === 0) {
        return { content: [{ type: "text" as const, text: `No matches for "${query}" on ${finalUrl}\nTITLE: ${title}\nPAGE TEXT: ${text.length} chars searched` }] };
      }

      const result = [
        `URL: ${finalUrl}`,
        ...(redirected(url, finalUrl) ? [`REQUESTED: ${url}`] : []),
        `TITLE: ${title}`,
        `MATCHES FOR "${query}": ${matches.length} block(s), ${occurrences} occurrence(s) in ${text.length} chars of page text${capped ? `, ${capped} block(s) trimmed` : ""}`,
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
    title: "Map a site",
    annotations: {
      title: "Map a site",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description: "Build a full structured map of a site in one call: every discovered page with title+summary, every form with fields+endpoint, every API hint. Returns a Site Awareness Object the AI can navigate programmatically. Use when you need to understand an entire site before taking action.",
    inputSchema: z.object({
      url: z.string().url().describe("The base URL of the site"),
      maxPages: z.number().int().positive().optional().default(10).describe("Max pages to FETCH (default 10) — the request budget, counting failures. Increase for larger sites."),
    }),
  },
  async ({ url, maxPages }) => {
    try {
      const origin = new URL(url).origin;
      const visited: Map<string, { title: string; summary: string; forms: ReturnType<typeof extractForms>; apiHints: string[] }> = new Map();
      const queue: string[] = [url];
      const max = maxPages ?? 10;
      // Requests, not stored pages. maxPages=10 against a page of 5,000 dead
      // links used to issue 5,001 requests, because failures never entered
      // `visited` and so never bounded the loop or the dedupe.
      const seen = new Set<string>([new URL(url).pathname]);
      const failures: Array<{ url: string; error: string }> = [];
      const offOrigin: string[] = [];
      let attempted = 0;

      while (queue.length > 0 && attempted < max) {
        const current = queue.shift()!;
        attempted++;

        try {
          const { html, finalUrl } = await fetchHTML(current, 8000);
          // A redirect off-origin must not be filed under this site's map.
          if (new URL(finalUrl).origin !== origin) {
            offOrigin.push(`${current} -> ${finalUrl}`);
            continue;
          }
          const finalPath = new URL(finalUrl).pathname;
          if (visited.has(finalPath)) continue;
          const text = htmlToText(html);
          const title = extractTitle(html);
          const summary = text.slice(0, 200).replace(/\n/g, " ");
          const forms = extractForms(html, finalUrl);
          const apiHints = extractApiHints(html);
          visited.set(finalPath, { title, summary, forms, apiHints });

          // Queue new same-origin links, resolved against the URL that served them
          for (const link of extractLinks(html, finalUrl)) {
            const linkPath = new URL(link).pathname;
            if (seen.has(linkPath)) continue;
            seen.add(linkPath);
            queue.push(link);
          }
        } catch (e) {
          failures.push({ url: current, error: e instanceof Error ? e.message : String(e) });
        }
      }

      const allForms = [...visited.values()].flatMap(v => v.forms);
      const allApiHints = [...new Set([...visited.values()].flatMap(v => v.apiHints))].sort();

      const obj = {
        url,
        pagesScanned: visited.size,
        // pagesScanned alone read as a small reassuring number while the
        // crawler was hammering a site; these three say what actually happened.
        pagesAttempted: attempted,
        pagesFailed: failures.length,
        budgetExhausted: attempted >= max && queue.length > 0,
        linksQueuedUnvisited: queue.length,
        pages: [...visited.entries()].map(([path, v]) => ({ path, title: v.title, summary: v.summary })),
        failures,
        offOriginRedirectsSkipped: offOrigin,
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
