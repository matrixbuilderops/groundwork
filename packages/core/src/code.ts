// ─────────────────────────────────────────────────────────────────────────────
// Structure scanners for the languages filelens names but cannot read
// ─────────────────────────────────────────────────────────────────────────────
// filelens's detectLanguage maps 28 extensions; buildOutline dispatches on four.
// A .rs file reported `LANGUAGE: Rust`, a line count, and zero symbols — which
// reads exactly like a Rust file that defines nothing. The existing code names
// that gap in a NOTE rather than hiding it, which is the right instinct and the
// wrong end state.
//
// Six of the seven languages here are brace-delimited, so they share one engine
// and differ only in which declarations they recognise. The engine's real work
// is not counting braces — it is knowing which braces are code. A `{` inside a
// string or a comment ends a function early and silently truncates every symbol
// after it, so every line is blanked of strings and comments before counting.

export interface OutlineNode {
  kind: string;
  name: string;
  /** 1-based, matching filelens. */
  startLine: number;
  endLine?: number;
  children: OutlineNode[];
}

// ── blanking ────────────────────────────────────────────────────────────────

export interface BlankState { inBlock: boolean; inRawString: string | null; }

/**
 * Replace string and comment content with spaces, preserving line length so
 * column positions stay meaningful.
 *
 * Rust lifetimes (`&'a str`) are the trap here: a lone `'` that opens no char
 * literal would swallow the rest of the line as an unterminated char. A quote
 * is only treated as a char literal when a closing quote appears within four
 * characters, which covers `'x'` and `'\\n'` and `'\\u{1F}'` but not `'a`.
 */
export function blankLine(line: string, st: BlankState): { code: string; state: BlankState } {
  let out = "";
  let i = 0;
  let { inBlock, inRawString } = st;

  while (i < line.length) {
    if (inRawString !== null) {
      if (line.startsWith(inRawString, i)) { out += " ".repeat(inRawString.length); i += inRawString.length; inRawString = null; }
      else { out += " "; i++; }
      continue;
    }
    if (inBlock) {
      if (line.startsWith("*/", i)) { out += "  "; i += 2; inBlock = false; }
      else { out += " "; i++; }
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "//") { out += " ".repeat(line.length - i); break; }
    if (two === "/*") { out += "  "; i += 2; inBlock = true; continue; }
    if (line[i] === "#" && /^\s*#/.test(line.slice(0, i + 1))) { out += " ".repeat(line.length - i); break; }

    const ch = line[i];
    if (ch === '"' || ch === "`") {
      // Go and Java text blocks use backticks / """; treat both as raw runs.
      out += " "; i++;
      while (i < line.length) {
        if (line[i] === "\\" && ch === '"') { out += "  "; i += 2; continue; }
        if (line[i] === ch) { out += " "; i++; break; }
        out += " "; i++;
      }
      continue;
    }
    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      if (close !== -1 && close - i <= 5) { out += " ".repeat(close - i + 1); i = close + 1; continue; }
      out += ch; i++;   // a lifetime, not a char literal
      continue;
    }
    out += ch; i++;
  }
  return { code: out, state: { inBlock, inRawString } };
}

function braceDelta(code: string): number {
  let d = 0;
  for (const c of code) { if (c === "{") d++; else if (c === "}") d--; }
  return d;
}

// ── the brace-language engine ───────────────────────────────────────────────

export interface DeclPattern { kind: string; re: RegExp; nameGroup?: number; }

/**
 * Walk `lines`, recognise declarations, and close each one at the brace that
 * returns to its opening depth.
 *
 * A declaration whose body never closes (truncated file, unbalanced braces)
 * gets no endLine rather than an invented one — an absent end is honest, a
 * wrong end sends a caller to read the wrong range.
 */
export function outlineBraces(lines: string[], patterns: DeclPattern[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const open: Array<{ node: OutlineNode; depth: number }> = [];
  let depth = 0;
  let st: BlankState = { inBlock: false, inRawString: null };

  for (let i = 0; i < lines.length; i++) {
    const { code, state } = blankLine(lines[i], st);
    st = state;

    for (const p of patterns) {
      const m = p.re.exec(code);
      if (!m) continue;
      const name = (m[p.nameGroup ?? 1] ?? "").trim();
      if (!name) continue;
      const node: OutlineNode = { kind: p.kind, name, startLine: i + 1, children: [] };
      const parent = open[open.length - 1];
      if (parent) parent.node.children.push(node); else roots.push(node);
      // Depth *after* this line's braces is where the body lives.
      open.push({ node, depth });
      break;
    }

    const before = depth;
    depth += braceDelta(code);
    // Close every declaration whose body has now ended.
    while (open.length && depth <= open[open.length - 1].depth && before !== depth) {
      const done = open.pop()!;
      done.node.endLine = i + 1;
    }
  }
  return roots;
}

// ── per-language declaration sets ───────────────────────────────────────────

const GO: DeclPattern[] = [
  { kind: "func", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/ },
  { kind: "type", re: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/ },
];

const RUST: DeclPattern[] = [
  { kind: "fn", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/ },
  { kind: "struct", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/ },
  { kind: "enum", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/ },
  { kind: "trait", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/ },
  { kind: "impl", re: /^\s*impl(?:\s*<[^>]*>)?\s+(.+?)\s*\{/ },
  { kind: "mod", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*\{/ },
];

const JAVA: DeclPattern[] = [
  { kind: "class", re: /^\s*(?:@\w+\s+)*(?:public|private|protected|abstract|final|static|sealed|strictfp|\s)*\bclass\s+([A-Za-z_]\w*)/ },
  { kind: "interface", re: /^\s*(?:@\w+\s+)*(?:public|private|protected|abstract|static|sealed|\s)*\binterface\s+([A-Za-z_]\w*)/ },
  { kind: "enum", re: /^\s*(?:@\w+\s+)*(?:public|private|protected|static|\s)*\benum\s+([A-Za-z_]\w*)/ },
  { kind: "record", re: /^\s*(?:@\w+\s+)*(?:public|private|protected|static|\s)*\brecord\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: "method", re: /^\s*(?:@\w+\s+)*(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp|\s)+(?:<[^>]+>\s*)?[\w.$<>\[\],?\s]+\s+([A-Za-z_]\w*)\s*\([^;]*$/ },
];

const CLIKE_TYPES: DeclPattern[] = [
  { kind: "namespace", re: /^\s*namespace\s+([A-Za-z_][\w.:]*)/ },
  { kind: "class", re: /^\s*(?:(?:public|private|protected|internal|abstract|sealed|static|partial|final)\s+)*class\s+([A-Za-z_]\w*)/ },
  { kind: "struct", re: /^\s*(?:(?:public|private|protected|internal|typedef)\s+)*struct\s+([A-Za-z_]\w*)/ },
  { kind: "enum", re: /^\s*(?:(?:public|private|protected|internal|typedef)\s+)*enum(?:\s+class)?\s+([A-Za-z_]\w*)/ },
];

/** Words that take a parenthesised argument list but are not declarations. */
const NOT_A_FUNCTION = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "defined",
  "else", "do", "case", "throw", "new", "delete", "and", "or", "not",
  "static_assert", "assert", "typeof", "alignof", "decltype", "noexcept",
]);

/**
 * C-family functions, which routinely do not fit on one line.
 *
 * `sph_echo.c` writes every function as
 *
 *     static void
 *     aes_2rounds_all(sph_u64 W[16][2],
 *                     int i0, int i1)
 *     {
 *
 * so a one-line regex found zero symbols in 1,033 lines — the exact "looks like
 * a file that defines nothing" failure this module exists to remove. Detection
 * is therefore structural: an identifier, a balanced argument list that may span
 * lines, then an opening brace that may be on a later line still.
 */
function outlineCLike(lines: string[]): OutlineNode[] {
  const code: string[] = [];
  let st: BlankState = { inBlock: false, inRawString: null };
  for (const raw of lines) { const r = blankLine(raw, st); code.push(r.code); st = r.state; }

  const roots: OutlineNode[] = [];
  const open: Array<{ node: OutlineNode; depth: number }> = [];
  let depth = 0;

  /** From (line,col) at a "(", return where the matching ")" closes. */
  const closeParen = (li: number, ci: number): { line: number; col: number } | null => {
    let d = 0;
    for (let i = li; i < Math.min(lines.length, li + 40); i++) {
      for (let c = i === li ? ci : 0; c < code[i].length; c++) {
        const ch = code[i][c];
        if (ch === "(") d++;
        else if (ch === ")") { d--; if (d === 0) return { line: i, col: c }; }
        else if (ch === ";" && d === 0) return null;
      }
    }
    return null;
  };

  /**
   * Is this a definition or just a prototype?
   *
   * `{` rarely follows `)` directly. C++ puts qualifiers between them
   * (`toJSON(...) const {`), constructors put an initialiser list there
   * (`Foo() : a(1), b(2) {`), and trailing return types put an arrow. Looking
   * only at the next character missed every const method in DmiReader.cpp.
   * Whichever of `{` or `;` comes first is the answer: brace means a body
   * follows, semicolon means this was a declaration.
   */
  const definitionFollows = (li: number, ci: number): boolean => {
    for (let i = li; i < Math.min(lines.length, li + 8); i++) {
      const seg = i === li ? code[i].slice(ci) : code[i];
      for (const ch of seg) {
        if (ch === "{") return true;
        if (ch === ";" || ch === "=") return false;
      }
    }
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = code[i];
    let node: OutlineNode | null = null;

    for (const p of CLIKE_TYPES) {
      const m = p.re.exec(line);
      if (m && m[1]) { node = { kind: p.kind, name: m[1], startLine: i + 1, children: [] }; break; }
    }

    if (!node) {
      // A continuation line of a constructor initialiser list —
      //     Foo::Foo(int a, int b)
      //       : m_a(a), m_b(b)
      //     {
      // — reads exactly like a definition: an identifier, a balanced argument
      // list, then a brace. `m_a` was reported as a function. Members are
      // introduced by `:` or `,`, and a real declaration never starts with
      // either, so leading punctuation is the tell.
      const cont = /^\s*[:,]/.test(line);
      const call = cont ? null : /([A-Za-z_~][\w]*)\s*\(/.exec(line);
      if (call && !NOT_A_FUNCTION.has(call[1])) {
        const openCol = line.indexOf("(", call.index + call[1].length);
        const close = openCol >= 0 ? closeParen(i, openCol) : null;
        if (close) {
          if (definitionFollows(close.line, close.col + 1)) {
            // Reach back over a bare return type on the preceding line.
            let start = i + 1;
            const prev = i > 0 ? code[i - 1].trim() : "";
            if (prev && !/[;{}():]$/.test(prev) && /^[A-Za-z_][\w\s*&:<>,]*$/.test(prev)) start = i;
            node = { kind: "func", name: call[1], startLine: start, children: [] };
          }
        }
      }
    }

    if (node) {
      const parent = open[open.length - 1];
      if (parent) parent.node.children.push(node); else roots.push(node);
      open.push({ node, depth });
    }

    const before = depth;
    depth += braceDelta(line);
    while (open.length && depth <= open[open.length - 1].depth && before !== depth) {
      open.pop()!.node.endLine = i + 1;
    }
  }
  return roots;
}

// ── indentation and keyword languages ───────────────────────────────────────

/** Ruby closes with `end` at the declaration's own indent. */
export function outlineRuby(lines: string[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const open: Array<{ node: OutlineNode; indent: number }> = [];
  const DECL = /^(\s*)(class|module|def)\s+([A-Za-z_][\w:.?!=]*)/;
  let st: BlankState = { inBlock: false, inRawString: null };

  for (let i = 0; i < lines.length; i++) {
    const { code, state } = blankLine(lines[i], st);
    st = state;
    const m = DECL.exec(code);
    if (m) {
      const indent = m[1].length;
      while (open.length && open[open.length - 1].indent >= indent) open.pop()!.node.endLine = i;
      const node: OutlineNode = { kind: m[2], name: m[3], startLine: i + 1, children: [] };
      const parent = open[open.length - 1];
      if (parent) parent.node.children.push(node); else roots.push(node);
      open.push({ node, indent });
      continue;
    }
    const e = /^(\s*)end\b/.exec(code);
    if (e && open.length) {
      const indent = e[1].length;
      while (open.length && open[open.length - 1].indent >= indent) open.pop()!.node.endLine = i + 1;
    }
  }
  return roots;
}

/** Shell: `name() {` and `function name {`. */
export function outlineShell(lines: string[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  // `print()` with `{` on the following line is idiomatic and was invisible:
  // 459 lines of shell reported zero functions. The brace is now allowed on
  // either line.
  const DECL = /^\s*(?:function\s+([A-Za-z_]\w*)\s*(?:\(\s*\))?|([A-Za-z_][\w-]*)\s*\(\s*\))\s*\{?\s*$/;
  let depth = 0;
  let cur: OutlineNode | null = null;
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/#.*$/, "");
    const m = DECL.exec(code);
    if (m && !cur) {
      const braceHere = code.includes("{");
      const braceNext = !braceHere && /^\s*\{/.test((lines[i + 1] ?? "").replace(/#.*$/, ""));
      if (braceHere || braceNext) {
        cur = { kind: "function", name: m[1] ?? m[2], startLine: i + 1, children: [] };
        out.push(cur);
        depth = 0;
      }
    }
    if (cur) {
      depth += braceDelta(code);
      if (depth <= 0) { cur.endLine = i + 1; cur = null; }
    }
  }
  return out;
}

// ── dispatch ────────────────────────────────────────────────────────────────

const BY_LANGUAGE: Record<string, (lines: string[]) => OutlineNode[]> = {
  Go: l => outlineBraces(l, GO),
  Rust: l => outlineBraces(l, RUST),
  Java: l => outlineBraces(l, JAVA),
  C: outlineCLike,
  "C++": outlineCLike,
  "C#": outlineCLike,
  Ruby: outlineRuby,
  Shell: outlineShell,
};

/** Languages this module can actually parse. */
export const SCANNED_LANGUAGES = Object.keys(BY_LANGUAGE);

/**
 * Outline `lines` as `language`, or null when there is no scanner — so the
 * caller can keep saying "nothing parsed this" instead of "this defines
 * nothing", which are different facts that look identical in an empty list.
 */
export function outlineCode(lines: string[], language: string): OutlineNode[] | null {
  const fn = BY_LANGUAGE[language];
  return fn ? fn(lines) : null;
}

export function countNodes(nodes: OutlineNode[]): number {
  return nodes.reduce((n, x) => n + 1 + countNodes(x.children), 0);
}
