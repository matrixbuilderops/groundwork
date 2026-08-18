/**
 * Outline contract tests.
 *
 * Ranges are checked against ground truth produced by real parsers — Python's
 * own `ast` for blocks.py, the TypeScript compiler for blocks.ts — not against
 * whatever the scanners happened to emit when these were written. The expected
 * numbers below are the parsers' answers. Anything the scanners get wrong is a
 * `todo`, so a gap is visible in the run rather than frozen in as correct.
 *
 * `npm run test:corpus` re-derives the package's headline accuracy claims
 * against 400 Python stdlib files and the installed TypeScript sources.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { callText, parseOutlineRows } from "./client.mjs";

const PY = "test/fixtures/blocks.py";
const TS = "test/fixtures/blocks.ts";

/** name -> [start, end], from `python3 -c "import ast"` over blocks.py. */
const PY_TRUTH = {
  one_liner: [5, 5],
  multi_line_signature: [8, 12],
  Container: [15, 35],
  first: [23, 24],
  after_comment: [29, 30],
  has_inner: [32, 35],
  inner: [33, 34],
  after_quote_data: [42, 44],
  Trailing: [47, 49],
  only: [48, 49],
};

/** name -> [start, end], from ts.createSourceFile over blocks.ts. */
const TS_TRUTH = {
  plainFunction: [4, 11],
  Widget: [13, 28],
  render: [17, 19],
  load: [21, 23],
  size: [25, 27],
  arrayToEnum: [32, 38],
  errToObj: [41, 42],
  assertNever: [46, 48],
  Trailing: [53, 55],
  last: [54, 54],
};

test("python: every emitted symbol carries the exact range ast reports", async () => {
  const { text } = await callText("file_outline", { path: PY });
  const rows = parseOutlineRows(text);
  for (const [name, [start, end]] of Object.entries(PY_TRUTH)) {
    const row = rows.get(name);
    assert.ok(row, `missing symbol ${name}`);
    assert.deepEqual([row.start, row.end], [start, end], `${name} range`);
  }
});

test("python: a def inside a docstring is not a symbol", async () => {
  const { text } = await callText("file_outline", { path: PY });
  assert.ok(!parseOutlineRows(text).has("not_real"), "docstring example emitted as a symbol");
  assert.ok(!parseOutlineRows(text).has("NotReal"));
});

test("python: a triple-quote stored as data does not mask the rest of the file", async () => {
  const { text } = await callText("file_outline", { path: PY });
  // QUOTE_AS_DATA = "'''" precedes these; counting delimiters per line hid them.
  const rows = parseOutlineRows(text);
  assert.ok(rows.has("after_quote_data"), "symbols after a quote-as-data line went missing");
  assert.ok(rows.has("Trailing"));
});

test("python: a def nested in a function is not a method of the enclosing class", async () => {
  const { text } = await callText("file_outline", { path: PY });
  // `inner` (33–34) sits inside has_inner (32–35), not directly in Container.
  // It must therefore render one level deeper than has_inner, not beside it.
  const lines = text.split("\n");
  const hasInner = lines.findIndex(l => /def has_inner/.test(l));
  const innerAt = lines.findIndex(l => /def inner\b/.test(l));
  assert.ok(hasInner !== -1 && innerAt === hasInner + 1, "inner should follow has_inner");
  const depth = l => l.length - l.replace(/^[│\s]*/, "").length;
  assert.ok(depth(lines[innerAt]) > depth(lines[hasInner]),
    `inner must nest deeper than has_inner:\n${lines[hasInner]}\n${lines[innerAt]}`);
});

test("typescript: every emitted symbol carries the exact range tsc reports", async () => {
  const { text } = await callText("file_outline", { path: TS });
  const rows = parseOutlineRows(text);
  for (const name of ["plainFunction", "Widget", "render", "load", "errToObj", "assertNever", "last"]) {
    const row = rows.get(name);
    assert.ok(row, `missing symbol ${name}`);
    assert.deepEqual([row.start, row.end], TS_TRUTH[name], `${name} range`);
  }
});

test("typescript: `export default class` is a class", async () => {
  const { text } = await callText("file_outline", { path: TS });
  const row = parseOutlineRows(text).get("Trailing");
  assert.ok(row, "Trailing missing");
  assert.deepEqual([row.start, row.end], TS_TRUTH.Trailing);
});

test("typescript: get/set accessors are members", async () => {
  const { text } = await callText("file_outline", { path: TS });
  const row = parseOutlineRows(text).get("size");
  assert.ok(row, "size missing");
  assert.deepEqual([row.start, row.end], TS_TRUTH.size);
});

test("typescript: an arrow whose => lands on a later line is still a function", async () => {
  const { text } = await callText("file_outline", { path: TS });
  const row = parseOutlineRows(text).get("arrayToEnum");
  assert.ok(row, "arrayToEnum missing");
  assert.deepEqual([row.start, row.end], TS_TRUTH.arrayToEnum);
});

test("typescript: class members render as children of their class", async () => {
  const { text } = await callText("file_outline", { path: TS });
  assert.match(text, /class Widget[^\n]*\n│\s+├──\s+method render/);
});

test("the last top-level row does not draw a continuation bar for its children", async () => {
  const { text } = await callText("file_outline", { path: PY });
  // `└── class Trailing` is the last top-level row, so its children are indented
  // with spaces. A `│` here would be a bar descending from nothing. (Deeper
  // rows may legitimately start with `│` belonging to an outer level, so this
  // pins the specific last-child case rather than banning the character.)
  assert.match(text, /└── class Trailing[^\n]*\n {4}└── def only/);
});

test("a class nested inside a try/if block is still found", async () => {
  const { text } = await callText("file_outline", { path: TS });
  // Widget's members must not leak out to the top level.
  const topLevel = text.split("\n").filter(l => /^[├└]──/.test(l)).map(l => l.replace(/\s+lines.*$/, ""));
  assert.ok(!topLevel.some(l => /render|load|size/.test(l)), `members leaked to top level: ${topLevel.join(" | ")}`);
});

test("a large outline is paginated with a resumable footer, never silently cut", async () => {
  const { text } = await callText("file_outline", { path: PY, maxRows: 3 });
  assert.match(text, /\[showing 3 of \d+ symbols \(rows 1–3\) — call file_outline with offset=3/);
});

test("the offset the footer names actually continues the listing", async () => {
  const first = await callText("file_outline", { path: PY, maxRows: 3 });
  const second = await callText("file_outline", { path: PY, maxRows: 3, offset: 3 });
  const rows = t => t.split("\n").filter(l => /lines \d+/.test(l));
  const a = rows(first.text), b = rows(second.text);
  assert.ok(a.length > 0 && b.length > 0);
  assert.notDeepEqual(a, b, "offset returned the same page");
  assert.match(second.text, /rows 4–6/);
});

test("depth collapses members to a count instead of dropping them silently", async () => {
  const { text } = await callText("file_outline", { path: PY, depth: 1 });
  assert.match(text, /class Container[^\n]*\(\d+ members\)/);
  assert.ok(!/def first/.test(text), "depth=1 should not list members");
});

test("a small file gets no pagination footer at all", async () => {
  const { text } = await callText("file_outline", { path: TS });
  assert.ok(!/showing \d+ of/.test(text), "footer shown when everything fit");
});
