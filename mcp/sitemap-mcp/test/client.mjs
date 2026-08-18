/**
 * Minimal MCP stdio client plus a fixture web server.
 *
 * Tests drive the built server over JSON-RPC so they exercise the contract an
 * agent sees. The fixture server is loopback, which the destination policy
 * blocks by design, so every call here sets SITEMAP_ALLOW_PRIVATE — that the
 * tests need the opt-in is itself evidence the policy is on.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.join(HERE, "..", "build", "index.js");

/** Serve a { path: html } map on an ephemeral port. */
export async function serveFixture(pages) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = pages[url.pathname];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<title>404</title>not found");
      return;
    }
    if (typeof body === "function") return body(req, res, url);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise(r => server.close(r)),
  };
}

export async function callTool(name, args, { env = {} } = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    // Loopback fixtures are blocked by default; opt in explicitly.
    env: { ...process.env, SITEMAP_ALLOW_PRIVATE: "1", ...env },
  });

  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "sitemap-test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
  ];

  let out = "";
  proc.stdout.on("data", d => { out += d; });
  proc.stderr.resume();
  const done = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", resolve);
  });
  for (const l of lines) proc.stdin.write(JSON.stringify(l) + "\n");
  proc.stdin.end();
  await done;

  const r = out.trim().split("\n").filter(Boolean).map(l => JSON.parse(l)).find(x => x.id === 2);
  if (!r) throw new Error("no response from server");
  if (r.error) throw new Error(`rpc error: ${JSON.stringify(r.error)}`);
  return { text: r.result.content[0].text, isError: r.result.isError === true };
}
