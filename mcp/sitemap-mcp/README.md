# sitemap-mcp

MCP server for website awareness. Designed for AI agents that need to understand and interact with websites without being flooded with raw HTML.

## The problem

Fetching a website naively takes multiple round trips and returns noisy HTML:
```
curl URL → strip HTML → grep for content → fetch another page → repeat
```

SiteMap collapses that into **one call**.

## Install

Add to your `mcp.json`:

```json
{
  "mcpServers": {
    "sitemap": {
      "command": "npx",
      "args": ["-y", "sitemap-mcp"]
    }
  }
}
```

No install step. `npx` handles it automatically.

## Tools

### `site_search_page` — the power tool
Fetch a URL and search it for a term in one call. Returns only matching sections — not the whole page.

```
site_search_page("https://example.com/docs", "rate limit")
→ only the paragraphs that mention rate limiting
```

### `site_fetch_page`
Fetch a URL and return clean readable text — no HTML tags, no scripts, no navbars.

```
site_fetch_page("https://example.com/pricing")
→ clean text content only
```

### `site_outline`
Discover what pages and routes exist on a site. Fetches the root page and extracts all same-origin links, forms, and API hints — without fetching every page.

```
site_outline("https://example.com")
→ all discovered links, forms, API endpoints
```

### `site_awareness`
Full structured site map in one call: every page with title + summary, every form, every API hint. Use when you need to understand an entire site before taking action.

```
site_awareness("https://example.com", maxPages=10)
→ { pages, forms, apiHints } as structured JSON
```

## Part of groundwork

[github.com/matrixbuilderops/groundwork](https://github.com/matrixbuilderops/groundwork) — the foundational awareness layer for AI agents. Pair with [filelens-mcp](https://www.npmjs.com/package/filelens-mcp) for intelligent file reading.
