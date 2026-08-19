// ─────────────────────────────────────────────────────────────────────────────
// A minimal HTML tree
// ─────────────────────────────────────────────────────────────────────────────
// The published packages parse HTML with regexes and no dependency, which keeps
// `npx sitemap-mcp` instant. Template detection needs sibling relationships that
// a flat regex pass cannot express, so this builds the smallest tree that answers
// "which of these elements repeat, and what differs between them".
//
// It is deliberately not a spec-compliant parser. Malformed markup degrades into
// a shallower tree rather than throwing — a wrong tree still yields useful
// repeats, whereas a thrown error yields nothing.

/** Elements that never have a closing tag, so they must not open a scope. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Elements whose content is not markup — skipped wholesale during parsing. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

export interface Node {
  tag: string;
  cls: string[];
  id: string;
  attrs: string;
  depth: number;
  parent: Node | null;
  children: Node[];
  /** Text belonging directly to this element, excluding descendants. */
  text: string;
}

function parseClasses(attrs: string): string[] {
  const m = /class\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const raw = m ? (m[2] ?? m[3] ?? m[4] ?? "") : "";
  return raw.split(/\s+/).filter(Boolean);
}

export function attrValue(attrs: string, name: string): string {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(attrs);
  // Attribute values are entity-encoded in the source: an href reads
  // `a?x=1&amp;y=2`. Returned raw it is not a usable URL, so decode here rather
  // than making every caller remember to.
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : "";
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™",
  laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Collapse runs of whitespace; HTML treats them all as one space. */
export function normalizeText(s: string): string {
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

/**
 * Build a tree from `html`.
 *
 * Returns a synthetic root whose children are the top-level elements. A close
 * tag with no matching open is ignored rather than unwinding the stack, because
 * real pages contain stray `</div>`s and unwinding on them collapses the rest
 * of the document into the root.
 */
export function parse(html: string): Node {
  const root: Node = {
    tag: "#root", cls: [], id: "", attrs: "", depth: -1,
    parent: null, children: [], text: "",
  };
  let cur = root;
  const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = TAG.exec(html)) !== null) {
    const [whole, close, rawTag, attrs, selfClose] = m;
    const tag = rawTag.toLowerCase();

    const between = html.slice(last, m.index);
    if (between) {
      const t = normalizeText(between);
      if (t) cur.text = cur.text ? `${cur.text} ${t}` : t;
    }
    last = m.index + whole.length;

    if (close) {
      // Unwind to the nearest matching ancestor. If there is none, this is a
      // stray close tag — ignore it and keep the current scope.
      let seek: Node | null = cur;
      while (seek && seek.tag !== tag) seek = seek.parent;
      if (seek && seek.parent) cur = seek.parent;
      continue;
    }

    if (RAW_TEXT.has(tag)) {
      // Skip the element's contents entirely; `harvest` reads <script> from the
      // raw HTML, and script bodies contain `<` that would corrupt the tree.
      const end = new RegExp(`</${tag}\\s*>`, "i");
      end.lastIndex = last;
      const rest = html.slice(last);
      const hit = end.exec(rest);
      if (hit) {
        last = last + hit.index + hit[0].length;
        TAG.lastIndex = last;
      }
      continue;
    }

    const node: Node = {
      tag, attrs, cls: parseClasses(attrs), id: attrValue(attrs, "id"),
      depth: cur.depth + 1, parent: cur, children: [], text: "",
    };
    cur.children.push(node);
    if (!VOID.has(tag) && !selfClose) cur = node;
  }

  const tail = normalizeText(html.slice(last));
  if (tail) cur.text = cur.text ? `${cur.text} ${tail}` : tail;
  return root;
}

/** All descendants of `n`, depth-first, excluding `n` itself. */
export function descendants(n: Node): Node[] {
  const out: Node[] = [];
  const walk = (x: Node) => { for (const c of x.children) { out.push(c); walk(c); } };
  walk(n);
  return out;
}

/** Concatenated text of `n` and everything under it. */
export function innerText(n: Node): string {
  const parts: string[] = [];
  const walk = (x: Node) => {
    if (x.text) parts.push(x.text);
    for (const c of x.children) walk(c);
  };
  walk(n);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
