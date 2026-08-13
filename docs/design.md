# Design Notes

## Core Philosophy

> **Build a map → navigate by query → fetch only what's needed**

AI agents are routinely handed raw data — full HTML pages, entire files — and expected to extract signal from noise. This is the wrong approach. It wastes context window, increases latency, and produces worse results because the AI spends cycles on irrelevant content.

The right approach is the same one a senior engineer or experienced researcher uses:

1. **Get the structure first** — what is this thing? what's in it?
2. **Navigate to the relevant section** — where is what I need?
3. **Read only that section** — nothing else

groundwork implements this pattern for two data sources: websites (SiteMap) and files (FileLens).

---

## SiteMap Architecture

### Problem
Raw HTML is ~80% noise. An AI handed a raw HTML dump sees navbars, script tags, ad pixels, footer links, and cookie banners — and somewhere in there, the actual content.

### Solution
SiteMap processes raw HTML into a typed, structured Site Awareness Object before the AI ever sees it. The AI gets:
- Pages with clean Markdown content (noise stripped by Trafilatura)
- Forms as typed objects with fields and endpoints
- Buttons and links as callable Action objects
- API endpoints hinted from script tags and data attributes

### Pipeline

```
URL
 └─ crawler.py        Playwright headless browser, follows same-origin links
      └─ parser.py    BeautifulSoup: extracts forms, actions, auth signals
      └─ extractor.py Trafilatura: strips noise, returns Markdown per page
           └─ models.py   Pydantic: assembles Site Awareness Object
                └─ sitemap.py   Public API: SiteMap.build(url)
```

### Key design decision: actions as tools
Every interactive element on a site (button, form, search input) is modelled as a callable Action or Form object. This means an AI agent can treat site interactions as function calls — `submit_form(email, password)`, `navigate("/pricing")`, `search_site("pricing")` — rather than having to figure out how to interact with raw DOM.

---

## FileLens Architecture

### Problem
Reading a file top-to-bottom with `cat` works for 50-line files. For real codebases — 500, 2000, 10,000 lines — it floods the context window with code the AI doesn't need, making it harder to find what matters.

### Solution
FileLens forces a structured reading workflow:

```
outline()       Always first. Costs almost nothing.
                Tells the AI: classes, functions, line numbers.
    │
    ├─ search() AI knows what it wants but not where it is.
    │           Returns matching lines + context.
    │
    ├─ chunk()  AI knows exactly which lines to read (from outline or search).
    │           Returns only those lines, numbered.
    │
    └─ summarize()  AI has never seen this file.
                    Returns structure + head + tail in one block.
```

### Key design decision: outline is always free
The `outline()` call reads the file once with regex — no LLM, no embedding, no network. It runs in milliseconds. This means there is no cost reason to skip it. The AI should always call `outline()` before any other mode.

### Language support
- **Python**: class and def detection with indent-aware method nesting
- **JavaScript / TypeScript**: function, class, arrow function, method detection
- **Markdown**: heading hierarchy (h1/h2/h3)
- **Everything else**: outline returns empty nodes (chunk and search still work)

---

## Shared principles

Both tools:
- Return **typed Pydantic objects** — not raw strings — so AI agents can navigate programmatically
- Are designed to be called as **AI tools** (function calling / MCP tools), not CLI commands
- Produce output that is **directly pasteable into an AI prompt** with no post-processing
- Operate on the **map-first** principle — structure before content, always
