#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// groundwork-extract — run the ladder against a URL and show what it recovered
// ─────────────────────────────────────────────────────────────────────────────
// The point of a CLI front door is that the engine can be judged against real
// pages before any MCP wiring exists. Same code path the MCP adapter will call.
//
//   groundwork-extract <url> [--json] [--records N]

import { extract } from "./extract.js";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const MAX_BODY = 8 * 1024 * 1024;

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BODY) throw new Error(`body too large (${buf.byteLength} bytes)`);
  return new TextDecoder("utf-8").decode(buf);
}

function main(argv: string[]): Promise<void> | void {
  const args = argv.filter(a => !a.startsWith("--"));
  const json = argv.includes("--json");
  const nArg = argv.find(a => a.startsWith("--records="));
  const showRecords = nArg ? Number(nArg.split("=")[1]) : 3;
  const url = args[0];
  if (!url) {
    console.error("usage: groundwork-extract <url> [--json] [--records=N]");
    process.exit(1);
  }

  return fetchHtml(url).then(html => {
    const r = extract(html, url);
    if (json) { console.log(JSON.stringify(r, null, 2)); return; }

    const pct = (n: number) => `${Math.round(n * 100)}%`;
    console.log(`\n${r.title || "(no title)"}`);
    console.log(`${url}`);
    console.log(`  raw HTML     ${html.length.toLocaleString()} bytes`);
    console.log(`  as prose     ${r.text.length.toLocaleString()} bytes`);
    console.log(`  answered by  ${r.level === null ? "neither level" : `level ${r.level}`}`);
    console.log(`  sources      ${r.sources.join(", ") || "—"}`);
    console.log(`  fields       ${r.fieldCount.toLocaleString()}`);
    if (r.requiresAuth) console.log(`  ! auth wall detected — needs the credentialed browser`);

    for (const t of r.templates.slice(0, 3)) {
      console.log(`\n  ${t.selector} × ${t.count}`);
      for (const f of t.fields.slice(0, 6)) {
        console.log(`    ${f.name.padEnd(20)} fill ${pct(f.fill).padStart(4)}  varies ${pct(f.variance).padStart(4)}   ${f.path}`);
      }
      for (const rec of t.records.slice(0, showRecords)) {
        const line = Object.entries(rec).map(([k, v]) => `${k}=${JSON.stringify(v.slice(0, 40))}`).join("  ");
        console.log(`    · ${line.slice(0, 160)}`);
      }
    }
    console.log("");
  });
}

Promise.resolve(main(process.argv.slice(2))).catch((e: unknown) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
