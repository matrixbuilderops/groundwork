// ─────────────────────────────────────────────────────────────────────────────
// Level 2 — recover the template a page was rendered from
// ─────────────────────────────────────────────────────────────────────────────
// A listing page is one template applied to N rows of data. Emitting the 24
// near-identical DOM subtrees costs 24× what emitting the schema plus 24 records
// costs, and tells the model less, because "these are the same shape" is exactly
// the fact the markup buries.
//
// The hard part is not finding repeats — every page repeats something. It is
// telling data apart from furniture. A nav bar, a tag cloud, and a table of
// results are all "repeated siblings"; only one is data. The filter that
// separates them is variance: real records differ from each other field by
// field, while furniture repeats the same handful of values.

import { Node, descendants, innerText, attrValue } from "./html.js";

// ── where a template sits ────────────────────────────────────────────────────
// Variance separates data from *identical* furniture, but a navigation menu has
// varied labels and sails straight through it — on lemonde.fr the burger menu
// outranked the news. Position is the signal variance cannot supply: page
// furniture lives in nav/header/footer/aside, content lives in main/article.

const CHROME_ANCESTORS = new Set(["nav", "header", "footer", "aside"]);
const CONTENT_ANCESTORS = new Set(["main", "article"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "search", "menu", "menubar"]);
const CHROME_WORDS = /\b(nav|navbar|navigation|menu|burger|sidebar|breadcrumb|footer|header|toolbar|pagination|social|share|cookie|consent|skip-link)\b/i;

export type Region = "content" | "chrome" | "unknown";

function regionOf(n: Node): Region {
  for (let p: Node | null = n; p; p = p.parent) {
    if (CHROME_ANCESTORS.has(p.tag)) return "chrome";
    const role = attrValue(p.attrs, "role").toLowerCase();
    if (CHROME_ROLES.has(role)) return "chrome";
    if (p.cls.some(c => CHROME_WORDS.test(c)) || CHROME_WORDS.test(p.id)) return "chrome";
    if (CONTENT_ANCESTORS.has(p.tag) || role === "main") return "content";
  }
  return "unknown";
}

export interface Field {
  /** Path from the record root, e.g. `h3>a` — unambiguous, if ugly. */
  path: string;
  /** A readable name derived from class or tag, unique within the template. */
  name: string;
  /** Fraction of records that carry this field, 0–1. */
  fill: number;
  /** Fraction of present values that are distinct — the data/furniture signal. */
  variance: number;
}

export interface Template {
  /** CSS-ish description of the repeated element, e.g. `div.release__meta`. */
  selector: string;
  count: number;
  fields: Field[];
  records: Array<Record<string, string>>;
  /** Whether this sits in page content or page furniture. */
  region: Region;
  /** Share of the page's total text this template accounts for, 0–1. */
  coverage: number;
  /** 0–1. Low means "found something, do not trust it" — emit, never hide. */
  confidence: number;
  /** Ranking key, region- and coverage-weighted. */
  score: number;
}

const SKIP_TAGS = new Set(["script", "style", "svg", "path", "br", "hr", "noscript"]);

/** Two siblings belong to the same template if tag and class list agree. */
function signature(n: Node): string {
  return n.cls.length ? `${n.tag}.${[...n.cls].sort().join(".")}` : n.tag;
}

function shortSelector(n: Node): string {
  return n.cls.length ? `${n.tag}.${n.cls[0]}` : n.tag;
}

/**
 * Field paths within one record, keyed by position so that two `<a>` siblings
 * do not collapse into one field.
 */
function fieldsOf(record: Node): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();

  const add = (key: string, value: string) => {
    if (!value) return;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    out.set(n === 1 ? key : `${key}[${n}]`, value);
  };

  for (const d of descendants(record)) {
    if (SKIP_TAGS.has(d.tag)) continue;
    const rel: string[] = [];
    for (let p: Node | null = d; p && p !== record; p = p.parent) rel.unshift(shortSelector(p));
    const path = rel.join(">");
    if (d.text) add(path, d.text);
    if (d.tag === "a") {
      const href = attrValue(d.attrs, "href");
      if (href && !href.startsWith("javascript:")) add(`${path}@href`, href);
    }
    if (d.tag === "img") {
      const alt = attrValue(d.attrs, "alt");
      if (alt) add(`${path}@alt`, alt);
    }
  }
  // A record with no descendant text still has its own text worth keeping.
  if (out.size === 0 && record.text) out.set("", record.text);
  return out;
}

function readableName(path: string, taken: Set<string>): string {
  const last = path.split(">").pop() ?? path;
  const attr = last.includes("@") ? last.split("@")[1] : "";
  const base = (last.split("@")[0].split(".")[1] ?? last.split("@")[0].split("[")[0] ?? "field")
    .replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "field";
  let name = attr ? `${base}_${attr}` : base;
  let i = 2;
  while (taken.has(name)) name = `${attr ? `${base}_${attr}` : base}_${i++}`;
  taken.add(name);
  return name;
}

export interface DetectOptions {
  /** Fewer repeats than this is a coincidence, not a template. */
  minCount?: number;
  /** Drop fields present in fewer than this fraction of records. */
  minFill?: number;
  /** Drop templates whose fields barely vary — that is furniture, not data. */
  minVariance?: number;
  maxTemplates?: number;
  maxRecords?: number;
  /** Drop templates the engine does not trust. */
  minConfidence?: number;
}

/**
 * Find the repeating structures in `root` and return them as schema + records,
 * best first.
 */
export function detectTemplates(root: Node, opts: DetectOptions = {}): Template[] {
  const totalText = innerText(root).length;
  const minCount = opts.minCount ?? 3;
  const minFill = opts.minFill ?? 0.5;
  const minVariance = opts.minVariance ?? 0.3;
  const maxTemplates = opts.maxTemplates ?? 5;
  const maxRecords = opts.maxRecords ?? 200;
  const minConfidence = opts.minConfidence ?? 0.3;

  const groups: Node[][] = [];
  const collect = (parent: Node) => {
    const bySig = new Map<string, Node[]>();
    for (const c of parent.children) {
      if (SKIP_TAGS.has(c.tag)) continue;
      const s = signature(c);
      const arr = bySig.get(s);
      if (arr) arr.push(c); else bySig.set(s, [c]);
    }
    for (const arr of bySig.values()) if (arr.length >= minCount) groups.push(arr);
    for (const c of parent.children) collect(c);
  };
  collect(root);

  const templates: Template[] = [];
  for (const group of groups) {
    const members = group.slice(0, maxRecords);
    const maps = members.map(fieldsOf);

    const pathCount = new Map<string, number>();
    for (const m of maps) for (const k of m.keys()) pathCount.set(k, (pathCount.get(k) ?? 0) + 1);

    const fields: Field[] = [];
    for (const [path, present] of pathCount) {
      const fill = present / members.length;
      if (fill < minFill) continue;
      const values = maps.map(m => m.get(path)).filter((v): v is string => v !== undefined);
      const distinct = new Set(values).size;
      fields.push({ path, name: "", fill, variance: values.length ? distinct / values.length : 0 });
    }
    if (!fields.length) continue;

    // Furniture check: if no field meaningfully varies, this repeats chrome.
    const bestVariance = Math.max(...fields.map(f => f.variance));
    if (bestVariance < minVariance) continue;

    fields.sort((a, b) => (b.fill * b.variance) - (a.fill * a.variance));
    const taken = new Set<string>();
    for (const f of fields) f.name = readableName(f.path, taken);

    const records = maps.map(m => {
      const rec: Record<string, string> = {};
      for (const f of fields) {
        const v = m.get(f.path);
        if (v !== undefined) rec[f.name] = v;
      }
      return rec;
    }).filter(r => Object.keys(r).length > 0);
    if (!records.length) continue;

    const region = regionOf(members[0]);
    const bytes = records.reduce((n, r) => n + Object.values(r).join(" ").length, 0);
    const coverage = totalText > 0 ? Math.min(1, bytes / totalText) : 0;

    // Confidence is deliberately harsh on chrome. A nav menu can have perfect
    // fill and variance; what it cannot have is a large share of the page's text
    // while sitting inside <main>.
    const regionWeight = region === "content" ? 1 : region === "unknown" ? 0.6 : 0.15;
    const confidence = Math.min(1,
      regionWeight * (0.35 + 0.4 * coverage + 0.25 * bestVariance));

    templates.push({
      selector: shortSelector(members[0]),
      count: group.length,
      fields, records, region, coverage, confidence,
      score: group.length * fields.length * regionWeight * (0.5 + coverage),
    });
  }

  // Nested elements produce overlapping groups; keep the strongest per selector.
  const best = new Map<string, Template>();
  for (const t of templates) {
    const prior = best.get(t.selector);
    if (!prior || t.score > prior.score) best.set(t.selector, t);
  }
  return [...best.values()]
    .filter(t => t.confidence >= minConfidence)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTemplates);
}

/** Total text length across a template's records — used to compare with prose. */
export function templateBytes(t: Template): number {
  return t.records.reduce((n, r) => n + Object.values(r).join("").length, 0);
}

export { innerText };
