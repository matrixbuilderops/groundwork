// ─────────────────────────────────────────────────────────────────────────────
// Level 1 — harvest the data the page already ships
// ─────────────────────────────────────────────────────────────────────────────
// Server-rendered frameworks serialize the page's own data model into a <script>
// tag and hydrate from it. That blob is the site's real schema: typed, complete,
// and already structured. Text extraction throws it away — `stripChrome` deletes
// <script> before any text is read — so the richest source on the page is the
// one thing the current pipeline is guaranteed to discard.
//
// This is cheap (a regex and JSON.parse) and either hits or misses cleanly. It
// misses on most sites; when it hits, it returns hundreds to thousands of fields
// that no amount of DOM work would reconstruct.

export type HarvestKind = "ld+json" | "__NEXT_DATA__" | "__NUXT_DATA__" | "hydration";

export interface Harvest {
  kind: HarvestKind;
  /** Where in the page it came from, for provenance in the output. */
  label: string;
  data: unknown;
}

/** Count scalar leaves — the honest measure of how much data a blob carries. */
export function countFields(value: unknown, depth = 0): number {
  if (depth > 40) return 0;
  if (Array.isArray(value)) {
    let n = 0;
    for (const v of value) n += countFields(v, depth + 1);
    return n;
  }
  if (value && typeof value === "object") {
    let n = 0;
    for (const v of Object.values(value)) n += countFields(v, depth + 1);
    return n;
  }
  return value === null || value === undefined ? 0 : 1;
}

function scriptBodies(html: string, attrMatch: RegExp): string[] {
  const out: string[] = [];
  const re = /<script\b((?:"[^"]*"|'[^']*'|[^>])*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (attrMatch.test(m[1])) out.push(m[2]);
  }
  return out;
}

function tryParse(text: string): unknown | undefined {
  const t = text.trim();
  if (!t) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

/**
 * Pull every embedded JSON source out of `html`.
 *
 * JSON-LD is unwrapped one level: publishers commonly emit `{"@graph":[...]}`,
 * and the graph entries are the actual records. Returning the wrapper would
 * report one field where there are hundreds.
 */
export function harvest(html: string): Harvest[] {
  const out: Harvest[] = [];

  for (const body of scriptBodies(html, /type\s*=\s*["']?application\/ld\+json/i)) {
    const parsed = tryParse(body);
    if (parsed === undefined) continue;
    const graph = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && "@graph" in (parsed as Record<string, unknown>)
      ? (parsed as Record<string, unknown>)["@graph"]
      : parsed;
    out.push({ kind: "ld+json", label: "ld+json", data: graph });
  }

  for (const [id, kind] of [
    ["__NEXT_DATA__", "__NEXT_DATA__"],
    ["__NUXT_DATA__", "__NUXT_DATA__"],
  ] as const) {
    for (const body of scriptBodies(html, new RegExp(`id\\s*=\\s*["']?${id}`, "i"))) {
      const parsed = tryParse(body);
      if (parsed !== undefined) out.push({ kind, label: id, data: parsed });
    }
  }

  // Generic hydration: `window.__SOMETHING__ = {...};` — used by Apollo, Redux,
  // Nuxt 2, and most hand-rolled SSR. Only object/array literals are taken; a
  // function or a bare string is app code, not data.
  const HYDRATE = /window\.(__[A-Z0-9_]+__)\s*=\s*({[\s\S]*?}|\[[\s\S]*?\])\s*;?\s*(?:<\/script>|\n)/g;
  let h: RegExpExecArray | null;
  while ((h = HYDRATE.exec(html)) !== null) {
    const parsed = tryParse(h[2]);
    if (parsed !== undefined && countFields(parsed) > 0) {
      out.push({ kind: "hydration", label: `window.${h[1]}`, data: parsed });
    }
  }

  return out;
}
