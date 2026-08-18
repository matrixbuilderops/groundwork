/**
 * Extraction and destination-policy contract tests.
 *
 * Each case is a defect that reached a published version, so the assertion is
 * on observable output rather than internals. `todo` marks a known gap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, serveFixture } from "./client.mjs";

const PAGE = `<!doctype html><html><head><title>Docs</title></head><body>
<header><h1>THE REAL HEADLINE</h1><p>Lead paragraph that matters.</p></header>
<nav><a href="/elsewhere">nav link</a></nav>
<main>
  <p>Body text. Caf&#233; &copy; 2026 &mdash; 5 &lt; 9 &amp;amp; more &#x2014; done.</p>
  <h2>Install</h2><p>Install instructions.</p>
  <h2>Usage</h2><p>Usage instructions.</p>
</main>
<footer><p>footer junk</p></footer>
</body></html>`;

const TOC = `<title>TOC</title><main>
<a href="#install">Install</a>
<a href="#usage">Usage</a>
<a href="/docs/deep">Deep</a>
<a href="?page=2">Page 2</a>
</main>`;

async function withSite(pages, fn) {
  const site = await serveFixture(pages);
  try { return await fn(site); } finally { await site.close(); }
}

test("content inside <header> survives when it holds the page headline", async () => {
  await withSite({ "/": PAGE }, async site => {
    const { text } = await callTool("site_fetch_page", { url: site.origin + "/" });
    assert.match(text, /THE REAL HEADLINE/);
    assert.match(text, /Lead paragraph that matters/);
  });
});

test("chrome without real content is still stripped", async () => {
  await withSite({ "/": PAGE }, async site => {
    const { text } = await callTool("site_fetch_page", { url: site.origin + "/" });
    assert.ok(!/footer junk/.test(text), "footer leaked");
    assert.ok(!/nav link/.test(text), "nav leaked");
  });
});

test("entities decode, and decoding does not run twice", async () => {
  await withSite({ "/": PAGE }, async site => {
    const { text } = await callTool("site_fetch_page", { url: site.origin + "/" });
    assert.match(text, /Café/, "numeric entity");
    assert.match(text, /©/, "named entity");
    assert.match(text, /—/, "mdash");
    assert.match(text, /5 < 9/, "lt");
    assert.match(text, /—\s*done/, "hex entity");
    // The literal "&amp;amp;" must survive as "&amp;", not collapse to "&".
    assert.match(text, /&amp; more/, "double-decoded &amp;amp;");
  });
});

test("the destination policy blocks loopback unless opted in", async () => {
  await withSite({ "/": PAGE }, async site => {
    const { text, isError } = await callTool("site_fetch_page", { url: site.origin + "/" },
      { env: { SITEMAP_ALLOW_PRIVATE: "" } });
    assert.ok(isError, "loopback fetch should fail without the opt-in");
    assert.match(text, /127\.0\.0\.0\/8|loopback/, "error should name the rule");
    assert.match(text, /SITEMAP_ALLOW_PRIVATE/, "error should name the escape hatch");
  });
});

test("a redirect to another origin is not filed under this site", async () => {
  await withSite({
    "/": `<title>Home</title><a href="/jump">go</a>`,
    "/jump": (req, res) => { res.writeHead(302, { location: "https://example.com/" }); res.end(); },
  }, async site => {
    const { text } = await callTool("site_awareness", { url: site.origin + "/", maxPages: 5 });
    assert.ok(!/example\.com[^]*"title"/.test(text), "off-origin body filed as a page");
  });
});

test("fragment links are discovered — they are the page's own table of contents", async () => {
  await withSite({ "/": TOC, "/docs/deep": "<title>Deep</title><main>deep</main>" }, async site => {
    const { text } = await callTool("site_outline", { url: site.origin + "/" });
    assert.match(text, /#install/, "fragment link dropped");
    assert.match(text, /page=2/, "query-only link dropped");
  });
});

test("auth detection does not fire on a bare 401 inside unrelated prose", async () => {
  await withSite({ "/": `<title>Rooms</title><main>Room P401 schedule, price $401.</main>` }, async site => {
    const { text } = await callTool("site_outline", { url: site.origin + "/" });
    assert.match(text, /AUTH REQUIRED: false/);
  });
});

test("site_outline bounds its own output", async () => {
  const many = Array.from({ length: 4000 }, (_, i) => `<a href="/p/${i}">p${i}</a>`).join("");
  await withSite({ "/": `<title>Many</title><main>${many}</main>` }, async site => {
    const { text } = await callTool("site_outline", { url: site.origin + "/" });
    assert.ok(text.length < 100_000, `site_outline emitted ${text.length} chars unbounded`);
  });
});

const GUIDE = `<title>Guide</title><main>
<h1 id="intro">Introduction</h1><p>Intro body.</p>
<h2 id="install">Install</h2><p>Run npm install to begin.</p>
<h2 id="usage">Usage</h2><p>Call the thing.</p>
<h3>Advanced</h3><p>Deep detail.</p>
</main>`;

test("site_outline_page lists headings with their anchors and sizes", async () => {
  await withSite({ "/": GUIDE }, async site => {
    const { text } = await callTool("site_outline_page", { url: site.origin + "/" });
    assert.match(text, /SECTIONS \(4,/);
    assert.match(text, /h1 Introduction[^\n]*#intro/);
    assert.match(text, /h2 Install[^\n]*#install/);
    // Nesting should be visible, and the body must NOT come along.
    assert.match(text, /\n {2}h2 Install/);
    assert.ok(!/Run npm install/.test(text), "outline leaked page body");
  });
});

test("site_fetch_page returns just the requested section", async () => {
  await withSite({ "/": GUIDE }, async site => {
    const { text } = await callTool("site_fetch_page", { url: site.origin + "/", section: "#install" });
    assert.match(text, /SECTION: h2 Install \(#install\)/);
    assert.match(text, /Run npm install/);
    assert.ok(!/Deep detail/.test(text), "returned more than the section");
    assert.ok(!/Intro body/.test(text));
  });
});

test("a section can be addressed by heading text, not only by anchor", async () => {
  await withSite({ "/": GUIDE }, async site => {
    const { text } = await callTool("site_fetch_page", { url: site.origin + "/", section: "Advanced" });
    assert.match(text, /Deep detail/);
  });
});

test("an unknown section lists what is available instead of silently returning the page", async () => {
  await withSite({ "/": GUIDE }, async site => {
    const { text, isError } = await callTool("site_fetch_page", { url: site.origin + "/", section: "#nope" });
    assert.ok(isError);
    assert.match(text, /No section matching/);
    assert.match(text, /#intro, #install, #usage/);
  });
});

test("a page with no headings says so rather than pretending to have structure", async () => {
  await withSite({ "/": `<title>Flat</title><main><p>Just prose.</p></main>` }, async site => {
    const { text } = await callTool("site_outline_page", { url: site.origin + "/" });
    assert.match(text, /No headings on this page/);
  });
});
