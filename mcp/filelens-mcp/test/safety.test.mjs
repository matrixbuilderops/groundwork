/**
 * Refusals, budgets and honest counting.
 *
 * Every case here is something the server used to answer confidently and
 * wrongly: formatted binary, a hidden result cap, an unbounded regex.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callText } from "./client.mjs";

const PY = "test/fixtures/blocks.py";

function tmp(name, content) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "filelens-")), name);
  fs.writeFileSync(p, content);
  return p;
}

test("a binary file is refused, not rendered with a line-number gutter", async () => {
  const p = tmp("blob.bin", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x00]));
  const { text, isError } = await callText("file_chunk", { path: p, start: 1, end: 2 });
  assert.ok(isError, "binary should be an error");
  assert.match(text, /binary/i);
});

test("UTF-16 text is not mistaken for binary despite its NUL bytes", async () => {
  const p = tmp("utf16.py", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("def a():\n    pass\n", "utf16le")]));
  const { isError } = await callText("file_outline", { path: p });
  assert.ok(!isError, "BOM-marked UTF-16 should be accepted as text");
});

test("a directory is refused with a distinct message", async () => {
  const { text, isError } = await callText("file_outline", { path: os.tmpdir() });
  assert.ok(isError);
  assert.match(text, /directory/i);
});

test("a catastrophic-backtracking regex is refused instead of hanging", async () => {
  const started = Date.now();
  const { text, isError } = await callText("file_search", { path: PY, query: "(a+)+$", useRegex: true });
  assert.ok(isError, "nested quantifier should be refused");
  assert.match(text, /nested quantifier/);
  // The point of the refusal is that it is instant. Measured unguarded: 4,829ms
  // for a 28-char pattern, per non-matching line.
  assert.ok(Date.now() - started < 5000, "refusal should be immediate");
});

test("an ordinary regex still works", async () => {
  const { text, isError } = await callText("file_search", { path: PY, query: "^def \\w+", useRegex: true });
  assert.ok(!isError, text);
  assert.match(text, /matching line/);
});

test("an invalid regex reports itself as invalid", async () => {
  const { text, isError } = await callText("file_search", { path: PY, query: "(unclosed", useRegex: true });
  assert.ok(isError);
  assert.match(text, /Invalid regex/);
});

test("a literal query is not treated as a pattern", async () => {
  // "(" would be a syntax error if the escaping regressed.
  const { isError } = await callText("file_search", { path: PY, query: "one_liner(" });
  assert.ok(!isError);
});

test("the match count reports the file total, not the size of the page returned", async () => {
  const p = tmp("many.py", Array.from({ length: 50 }, (_, i) => `# needle ${i}`).join("\n") + "\n");
  const { text } = await callText("file_search", { path: p, query: "needle", maxResults: 3 });
  assert.match(text, /3 of 50 matching line\(s\)/, text.split("\n")[0]);
});

test("a very long line is trimmed around the match rather than shipped whole", async () => {
  const p = tmp("min.js", `${"x".repeat(50_000)}needle${"y".repeat(50_000)}\n`);
  const { text } = await callText("file_search", { path: p, query: "needle" });
  assert.ok(text.length < 5_000, `emitted ${text.length} chars for one match`);
  assert.match(text, /line trimmed to 800 of \d+ chars/);
});

test("file_fetch resolves a symbol to its exact range instead of grepping", async () => {
  const { text } = await callText("file_fetch", { path: PY, target: "multi_line_signature" });
  assert.match(text, /SYMBOL: def multi_line_signature\s+lines 8–12\s+\(5 lines\)/);
  // The whole-file outline must not ride along on a resolved fetch.
  assert.ok(!/STRUCTURE:/.test(text), "resolved fetch should not print the full outline");
});

test("file_fetch lists candidates when a name is ambiguous", async () => {
  const p = tmp("dup.py", "class A:\n    def go(self):\n        pass\n\nclass B:\n    def go(self):\n        pass\n");
  const { text } = await callText("file_fetch", { path: p, target: "go" });
  assert.match(text, /matches 2 symbols/);
});

test("file_fetch falls back to text search for a non-symbol, and says so", async () => {
  const { text } = await callText("file_fetch", { path: PY, target: "Runaway check" });
  assert.match(text, /is not a symbol in this file/);
});

test("a language with no scanner says so instead of returning a silent empty outline", async () => {
  const p = tmp("main.rs", "fn main() {\n    println!(\"hi\");\n}\n");
  const { text } = await callText("file_outline", { path: p });
  assert.match(text, /LANGUAGE: Rust/);
  assert.match(text, /no structure scanner/);
});
