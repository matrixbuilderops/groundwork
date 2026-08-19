/**
 * Scanner contract tests.
 *
 * Every case here is a shape that returned zero symbols against real source on
 * disk. Zero symbols is the dangerous output: it is indistinguishable from a
 * file that genuinely defines nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineCode, countNodes, blankLine, SCANNED_LANGUAGES } from "../build/index.js";

const names = ns => { const o=[]; (function w(x){for(const y of x){o.push(y.name); w(y.children);}})(ns); return o; };

test("the seven languages filelens named but could not read are covered", () => {
  for (const l of ["Go","Rust","Java","C","C++","C#","Ruby","Shell"])
    assert.ok(SCANNED_LANGUAGES.includes(l), `${l} missing`);
});

test("an unscanned language returns null, not an empty list", () => {
  // null means "nothing parsed this"; [] would mean "this defines nothing".
  assert.equal(outlineCode(["x = 1"], "TOML"), null);
});

// ── C: the sph_echo.c shape ─────────────────────────────────────────────────
test("a C function split across lines is found", () => {
  const src = `static void
aes_2rounds_all(sph_u64 W[16][2],
                int i0, int i1)
{
	int x;
}`.split("\n");
  const n = outlineCode(src, "C");
  assert.deepEqual(names(n), ["aes_2rounds_all"]);
  assert.equal(n[0].startLine, 1, "the return-type line is the start");
  assert.equal(n[0].endLine, 6);
});

test("a prototype is not a definition", () => {
  const src = [`static void helper(int a);`, `int main(void) {`, `  return 0;`, `}`];
  assert.deepEqual(names(outlineCode(src, "C")), ["main"]);
});

// ── C++: the DmiReader.cpp shape ────────────────────────────────────────────
test("trailing const does not hide a method", () => {
  const src = [`rapidjson::Value xmrig::DmiReader::toJSON(Document &doc) const`, `{`, `  return {};`, `}`];
  assert.deepEqual(names(outlineCode(src, "C++")), ["toJSON"]);
});

test("a constructor initialiser list does not hide the body", () => {
  const src = [`Foo::Foo(int a, int b)`, `  : m_a(a), m_b(b)`, `{`, `}`];
  assert.deepEqual(names(outlineCode(src, "C++")), ["Foo"]);
});

test("control-flow keywords are not functions", () => {
  const src = [`int main() {`, `  if (x) {`, `  }`, `  while (y) {`, `  }`, `}`];
  assert.deepEqual(names(outlineCode(src, "C")), ["main"]);
});

// ── braces that are not code ────────────────────────────────────────────────
test("a brace inside a string does not close a function early", () => {
  const src = [`void f() {`, `  const char *s = "}{";`, `  int x;`, `}`, `void g() {`, `}`];
  const n = outlineCode(src, "C");
  assert.deepEqual(names(n), ["f", "g"]);
  assert.equal(n[0].endLine, 4, "f must not end on the string line");
});

test("a brace inside a comment does not close a function early", () => {
  const src = [`void f() {`, `  /* } */`, `}`, `void g() {`, `}`];
  assert.deepEqual(names(outlineCode(src, "C")), ["f", "g"]);
});

// ── Rust ────────────────────────────────────────────────────────────────────
test("a lifetime is not an unterminated char literal", () => {
  const src = [`fn parse<'a>(s: &'a str) -> &'a str {`, `  s`, `}`, `fn after() {`, `}`];
  assert.deepEqual(names(outlineCode(src, "Rust")), ["parse", "after"]);
});

test("Rust nests impl blocks inside modules", () => {
  const src = [`mod m {`, `  struct S;`, `  impl S {`, `    pub fn go(&self) {`, `    }`, `  }`, `}`];
  const n = outlineCode(src, "Rust");
  assert.equal(n[0].name, "m");
  assert.ok(names(n).includes("go"));
  assert.ok(countNodes(n) >= 3);
});

// ── Ruby / Shell / Go / Java ────────────────────────────────────────────────
test("Ruby closes on end at matching indent", () => {
  const src = [`class Foo`, `  def bar`, `    1`, `  end`, `end`];
  const n = outlineCode(src, "Ruby");
  assert.equal(n[0].name, "Foo");
  assert.equal(n[0].children[0].name, "bar");
  assert.equal(n[0].children[0].endLine, 4);
  assert.equal(n[0].endLine, 5);
});

test("a shell function with the brace on the next line is found", () => {
  const src = [`print()`, `{`, `  echo hi`, `}`, `function two {`, `  echo x`, `}`];
  assert.deepEqual(names(outlineCode(src, "Shell")), ["print", "two"]);
});

test("Go finds methods with receivers", () => {
  const src = [`func (s *Server) Handle(w http.ResponseWriter) {`, `}`, `type Config struct {`, `}`];
  assert.deepEqual(names(outlineCode(src, "Go")), ["Handle", "Config"]);
});

test("Java finds a class and its methods", () => {
  const src = [`public class Foo {`, `  public static void main(String[] args) {`, `  }`, `}`];
  const n = outlineCode(src, "Java");
  assert.equal(n[0].name, "Foo");
  assert.ok(names(n).includes("main"));
});

test("blankLine leaves code intact and blanks the rest", () => {
  const { code } = blankLine(`int x = 1; // } comment`, { inBlock:false, inRawString:null });
  assert.ok(code.startsWith("int x = 1;"));
  assert.ok(!code.includes("}"));
});
