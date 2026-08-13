# SiteMap

**Website awareness layer for AI agents.**

> *"Don't read a website. Know it."*

---

## What is SiteMap?

When an AI agent needs to work with a website, the naive approach is to dump raw HTML into the context window. That approach fails — HTML is 80% noise (navbars, scripts, ads, footers) and gives the AI no concept of structure, interactivity, or what actions are available.

SiteMap solves this by doing what a human does when they first land on a site: **look around, build a mental model, then act.**

SiteMap crawls a URL, processes every page, and returns a single structured object — the **Site Awareness Object** — that the AI can reason over, navigate, and act on. The AI never sees raw HTML. It sees a clean, queryable map.

---

## What it produces: the Site Awareness Object

```json
{
  "url": "https://example.com",
  "pages": [
    { "path": "/",        "title": "Home",    "summary": "Landing page with sign-up CTA" },
    { "path": "/pricing", "title": "Pricing", "summary": "Three tiers: Free, Pro, Enterprise" }
  ],
  "forms": [
    { "page": "/signup", "fields": ["email", "password"], "action": "POST /api/register" }
  ],
  "actions": [
    { "label": "Buy Now", "type": "button",  "leads_to": "/checkout" },
    { "label": "Search",  "type": "input",   "endpoint": "/api/search?q=" }
  ],
  "auth": { "required": true, "method": "cookie/JWT" },
  "api_hints": ["/api/search", "/api/products"]
}
```

Every piece of information an AI needs to interact with a site — in one object.

---

## How it works

```
URL
 │
 ├─ Crawler (Playwright)
 │   Discovers all pages by following same-origin links.
 │   Uses a real headless browser — handles JS-rendered sites.
 │
 ├─ DOM Parser (BeautifulSoup)
 │   Extracts every form, button, link, and input from each page.
 │   Turns them into typed objects the AI can call.
 │
 ├─ Content Extractor (Trafilatura)
 │   Strips navbars, ads, scripts, footers.
 │   Returns clean Markdown content per page.
 │
 └─ Site Awareness Object (Pydantic)
     Assembles everything into one validated, serialisable object.
     Ready to be handed directly to an AI agent.
```

---

## Usage

```python
import asyncio
from sitemap.src import SiteMap

# Async
async def main():
    awareness = await SiteMap.build("https://example.com")
    print(awareness.model_dump_json(indent=2))

asyncio.run(main())

# Sync (convenience wrapper)
awareness = SiteMap.build_sync("https://example.com")
```

### What the AI does with it

```python
# AI can read any page by path
page = awareness.get_page("/pricing")
print(page.content_markdown)

# AI can see all available actions
for action in awareness.actions:
    print(action.label, "→", action.leads_to or action.endpoint)

# AI can submit a form
form = awareness.forms[0]
print(f"Submit to: {form.action} with fields: {form.fields}")

# Full JSON dump — paste directly into an AI prompt
print(awareness.model_dump_json(indent=2))
```

---

## File structure

```
sitemap/
├── src/
│   ├── __init__.py      # Exports SiteMap, SiteAwarenessObject
│   ├── sitemap.py       # Main entry point — SiteMap.build()
│   ├── models.py        # Pydantic models: SiteAwarenessObject, Page, Form, Action
│   ├── crawler.py       # Playwright-based route discovery
│   ├── parser.py        # DOM → forms, actions, auth detection
│   └── extractor.py     # HTML → clean Markdown, API hint detection
├── tests/
│   └── test_sitemap.py
└── pyproject.toml
```

---

## Install

```bash
pip install -e ./sitemap
playwright install chromium
```

---

## Also in this repo

**[FileLens](../filelens/)** does for files what SiteMap does for websites.
Instead of dumping a whole file into an AI's context, FileLens gives the AI
four targeted modes — outline, search, chunk, summarize — so it reads only
what it needs. Same principle, different data source.
