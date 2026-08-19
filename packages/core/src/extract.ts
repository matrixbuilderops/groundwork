// ─────────────────────────────────────────────────────────────────────────────
// The ladder
// ─────────────────────────────────────────────────────────────────────────────
// Levels are ordered by cost, and the first one that answers wins. Measured over
// five real pages: level 1 answered 1 of 5, level 2 answered 4 of 5, and together
// they answered 5 of 5. Neither is sufficient alone, which is the whole reason
// this is a ladder and not a single extractor.
//
//   1  embedded JSON      free      the site's own data model, when it ships one
//   2  template detection free      repeated structure, which nearly every page has
//   3  headless render    seconds   content that only exists after JS runs
//   4  credentialed browser         pages behind a login or bot wall
//
// Levels 3 and 4 need a browser and live elsewhere; this module owns 1 and 2 and
// reports when a page needs the rungs above.

import { parse, innerText, normalizeText, Node } from "./html.js";
import { harvest, countFields, Harvest } from "./harvest.js";
import { detectTemplates, Template, DetectOptions } from "./template.js";

export type Level = 1 | 2;

export interface Extraction {
  url: string;
  title: string;
  /** Which rung produced the records, or null if neither did. */
  level: Level | null;
  /** Provenance labels, e.g. ["ld+json", "__NEXT_DATA__"]. */
  sources: string[];
  harvested: Harvest[];
  templates: Template[];
  /** Scalar leaves recovered — comparable across levels. */
  fieldCount: number;
  /** True when the page looks like a login/bot wall, i.e. climb to level 4. */
  requiresAuth: boolean;
  /** Plain text, kept so callers can fall back to prose. */
  text: string;
}

/**
 * Auth signals. Bare substring tests fire on ordinary prose — "401" matches
 * "Room P401" and a price — so each pattern is anchored on word boundaries and
 * `401` only counts next to auth language.
 */
const AUTH_SIGNALS = [
  /\blog\s?in\b/i, /\bsign\s?in\b/i,
  /\bplease authenticate\b/i, /\bauthentication required\b/i,
  /\bunauthorized\b/i, /\baccess denied\b/i,
  /\bverify you are (?:a )?human\b/i, /\bchecking your browser\b/i,
  /\benable javascript\b/i,
];

/**
 * A wall, not a link.
 *
 * Nearly every site has "Sign in" in its nav, so auth language alone flagged
 * Hacker News and PyPI — both fully readable — and would have escalated them to
 * the credentialed browser for nothing. What distinguishes a real wall is that
 * it is *all there is*: login pages and bot challenges carry a few hundred bytes
 * of text, not thousands. Language plus thinness, never language alone.
 */
const WALL_MAX_TEXT = 2000;

export function requiresAuth(text: string, opts: { thin?: boolean } = {}): boolean {
  const thin = opts.thin ?? text.length < WALL_MAX_TEXT;
  if (!thin) return false;
  const head = text.slice(0, 4000);
  if (AUTH_SIGNALS.some(re => re.test(head))) return true;
  return /\b401\b\s*(?:error|unauthorized|forbidden)|(?:error|status)\s*:?\s*\b401\b/i.test(head);
}

function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return m ? normalizeText(m[1]) : "";
}

export interface ExtractOptions extends DetectOptions {
  /**
   * Level 1 must beat this many fields to win outright. Below it, a thin
   * ld+json block (just a logo and a site name, which is most of them) should
   * not shadow a page whose real content is a table.
   */
  minHarvestFields?: number;
}

/** Run levels 1 and 2 over one page. */
export function extract(html: string, url = "", opts: ExtractOptions = {}): Extraction {
  const minHarvestFields = opts.minHarvestFields ?? 25;

  const harvested = harvest(html);
  const root: Node = parse(html);
  const text = innerText(root);
  const templates = detectTemplates(root, opts);

  const harvestFields = harvested.reduce((n, h) => n + countFields(h.data), 0);
  const templateFields = templates.reduce(
    (n, t) => n + t.records.reduce((m, r) => m + Object.keys(r).length, 0), 0);

  let level: Level | null = null;
  if (harvestFields >= minHarvestFields && harvestFields >= templateFields) level = 1;
  else if (templateFields > 0) level = 2;
  else if (harvestFields > 0) level = 1;

  return {
    url,
    title: extractTitle(html),
    level,
    sources: level === 1 ? [...new Set(harvested.map(h => h.label))]
           : level === 2 ? templates.map(t => t.selector)
           : [],
    harvested,
    templates,
    fieldCount: level === 1 ? harvestFields : level === 2 ? templateFields : 0,
    requiresAuth: requiresAuth(text, { thin: level === null && text.length < WALL_MAX_TEXT }),
    text,
  };
}
