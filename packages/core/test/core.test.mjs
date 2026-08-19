/**
 * Contract tests for the extraction engine.
 *
 * Each case is a way the engine can look like it works while being wrong:
 * counting furniture as data, losing a record to a stray close tag, or letting
 * a three-field ld+json logo block outrank a real table.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, innerText, harvest, countFields, detectTemplates, extract, requiresAuth }
  from "../build/index.js";

// ── the tree ────────────────────────────────────────────────────────────────
test("script bodies never enter the tree", () => {
  const root = parse(`<div><script>var a = "<p>ghost</p>";</script><p>real</p></div>`);
  assert.equal(innerText(root), "real");
});

test("a stray close tag does not collapse the document", () => {
  const root = parse(`<div><p>one</p></span><p>two</p></div>`);
  assert.equal(innerText(root), "one two");
});

test("void elements do not swallow their siblings", () => {
  const root = parse(`<ul><li>a<br>b</li><li>c</li></ul>`);
  assert.equal(innerText(root), "a b c");
});

test("entities decode, including numeric", () => {
  const root = parse(`<p>Caf&#233; &amp; b&#xe4;r &copy;</p>`);
  assert.equal(innerText(root), "Café & bär ©");
});

// ── level 1 ─────────────────────────────────────────────────────────────────
test("ld+json is harvested and @graph is unwrapped", () => {
  const html = `<script type="application/ld+json">
    {"@graph":[{"@type":"Product","name":"A","price":1},{"@type":"Product","name":"B","price":2}]}
  </script>`;
  const [h] = harvest(html);
  assert.equal(h.kind, "ld+json");
  assert.ok(Array.isArray(h.data), "graph should be unwrapped to its entries");
  assert.equal(h.data.length, 2);
});

test("__NEXT_DATA__ is harvested", () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">{"props":{"x":1,"y":2}}</script>`;
  const [h] = harvest(html);
  assert.equal(h.kind, "__NEXT_DATA__");
  assert.equal(countFields(h.data), 2);
});

test("malformed JSON is skipped, not thrown", () => {
  assert.deepEqual(harvest(`<script type="application/ld+json">{oops</script>`), []);
});

test("countFields counts scalars, not containers", () => {
  assert.equal(countFields({ a: 1, b: { c: 2, d: [3, 4] } }), 4);
  assert.equal(countFields({ a: null }), 0);
});

// ── level 2 ─────────────────────────────────────────────────────────────────
const LISTING = `<ul class="results">
  <li class="row"><h3><a href="/a">Alpha</a></h3><span class="price">$1</span></li>
  <li class="row"><h3><a href="/b">Beta</a></h3><span class="price">$2</span></li>
  <li class="row"><h3><a href="/c">Gamma</a></h3><span class="price">$3</span></li>
  <li class="row"><h3><a href="/d">Delta</a></h3><span class="price">$4</span></li>
</ul>`;

test("a listing becomes schema plus records", () => {
  const [t] = detectTemplates(parse(LISTING));
  assert.equal(t.selector, "li.row");
  assert.equal(t.count, 4);
  assert.equal(t.records.length, 4);
  const values = t.records.map(r => Object.values(r).join(" "));
  assert.ok(values[0].includes("Alpha"), `expected Alpha in ${values[0]}`);
  assert.ok(values.some(v => v.includes("/a")), "hrefs should be captured as fields");
});

test("repeated furniture is rejected — identical values are not data", () => {
  const nav = `<ul>${'<li class="i"><a href="/x">Home</a></li>'.repeat(8)}</ul>`;
  assert.equal(detectTemplates(parse(nav)).length, 0);
});

test("two repeats are a coincidence, three are a template", () => {
  const two = `<ul><li class="r">a</li><li class="r">b</li></ul>`;
  assert.equal(detectTemplates(parse(two)).length, 0);
});

// ── the ladder ──────────────────────────────────────────────────────────────
test("a thin ld+json block does not outrank a real table", () => {
  const html = `<html><body>
    <script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>
    ${LISTING}</body></html>`;
  const r = extract(html);
  assert.equal(r.level, 2, "level 2 should win when the JSON is just a site header");
  assert.ok(r.fieldCount >= 8);
});

test("a rich JSON blob wins outright", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `n${i}`, price: i }));
  const html = `<html><body>
    <script id="__NEXT_DATA__">${JSON.stringify({ props: { rows } })}</script>
    ${LISTING}</body></html>`;
  const r = extract(html);
  assert.equal(r.level, 1);
  assert.equal(r.sources[0], "__NEXT_DATA__");
});

test("a page with neither reports level null, not a crash", () => {
  const r = extract(`<html><body><p>just prose</p></body></html>`);
  assert.equal(r.level, null);
  assert.equal(r.fieldCount, 0);
  assert.equal(r.text, "just prose");
});

// ── the escalation trigger ──────────────────────────────────────────────────
test("auth walls are detected", () => {
  assert.ok(requiresAuth("Please sign in to continue"));
  assert.ok(requiresAuth("Checking your browser before accessing"));
});

test("prose containing 401 is not an auth wall", () => {
  assert.equal(requiresAuth("Meet in Room P401 at noon; tickets are $401."), false);
});

// ── regressions found by running against live pages ─────────────────────────
test("href attributes are entity-decoded, so they are usable URLs", () => {
  const [t] = detectTemplates(parse(
    `<ul>${[1,2,3,4].map(i => `<li class="r"><a href="/go?id=${i}&amp;from=list">n${i}</a></li>`).join("")}</ul>`));
  const hrefs = t.records.map(r => Object.values(r).find(v => v.startsWith("/go")));
  assert.ok(hrefs[0].includes("&from="), `expected decoded &, got ${hrefs[0]}`);
  assert.ok(!hrefs[0].includes("&amp;"));
});

test("a Sign in link in the nav is not an auth wall", () => {
  const page = `<html><body><nav><a href="/login">Sign in</a></nav>
    <main>${"Real content that the page actually served. ".repeat(60)}</main></body></html>`;
  assert.equal(extract(page).requiresAuth, false);
});

test("a bot challenge with almost no text is an auth wall", () => {
  const wall = `<html><body><h1>Checking your browser before accessing</h1></body></html>`;
  assert.equal(extract(wall).requiresAuth, true);
});
