/**
 * Minimal MCP stdio client for tests.
 *
 * Tests drive the built server over JSON-RPC rather than importing its
 * internals, because the thing worth protecting is the contract an agent sees:
 * the rendered outline text, the error strings, the tool list. Importing
 * outlinePython() directly would keep passing while file_outline's rendering
 * regressed underneath it.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.join(HERE, "..", "build", "index.js");

/**
 * Start the server, run every call in order, return the results, stop it.
 * One process per batch keeps tests independent without paying spawn cost
 * per assertion.
 */
export async function callTools(calls, { env = {} } = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "filelens-test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ...calls.map((c, i) => ({
      jsonrpc: "2.0", id: i + 2,
      method: c.method ?? "tools/call",
      params: c.method ? c.params : { name: c.name, arguments: c.arguments ?? {} },
    })),
  ];

  let out = "";
  let err = "";
  proc.stdout.on("data", d => { out += d; });
  proc.stderr.on("data", d => { err += d; });

  const done = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", resolve);
  });

  for (const l of lines) proc.stdin.write(JSON.stringify(l) + "\n");
  proc.stdin.end();
  await done;

  const responses = out.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  const byId = new Map(responses.map(r => [r.id, r]));
  return {
    stderr: err,
    results: calls.map((_, i) => byId.get(i + 2)),
  };
}

/** The text of a single tool call, or throw with the server's error. */
export async function callText(name, args, opts) {
  const { results } = await callTools([{ name, arguments: args }], opts);
  const r = results[0];
  if (!r) throw new Error("no response from server");
  if (r.error) throw new Error(`rpc error: ${JSON.stringify(r.error)}`);
  return { text: r.result.content[0].text, isError: r.result.isError === true };
}

/** Parse `name  lines A–B` rows out of a rendered outline into a map. */
export function parseOutlineRows(text) {
  const rows = new Map();
  for (const line of text.split("\n")) {
    // Matches both top-level rows and the `name()` child rows.
    const m = line.match(/^[│├└─\s]*(?:(\w[\w ]*?)\s+)?([\w.$]+)\(?\)?\s+lines?\s+(\d+)(?:[–-](\d+))?\s*$/);
    if (!m) continue;
    rows.set(m[2], { kind: (m[1] ?? "").trim(), start: +m[3], end: m[4] ? +m[4] : undefined });
  }
  return rows;
}
