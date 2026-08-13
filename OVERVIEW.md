# groundwork — How It Works

Two tools. One idea. Give AI a map first, not a data dump.

---

## The idea

AI agents are handed raw data and told to figure it out:
- Paste a whole website's HTML → hope the AI finds what matters
- Read an entire file with `cat` → hope the AI finds the right function

This works on toy examples. It breaks on real ones.

The fix is the same in both cases:

> **Build a structured map first. Then navigate to exactly what's needed.**

---

## 🌐 SiteMap

**Problem:** AI gets raw HTML. 80% of it is noise — navbars, ads, scripts, footers.

**What SiteMap does:** Crawls a URL, processes every page, and returns one clean structured object — the **Site Awareness Object**. The AI never sees HTML. It sees a map.

```
URL  →  crawl all pages  →  parse forms/buttons/links  →  clean content  →  Site Awareness Object
```

**What the AI gets back:**

```json
{
  "url": "https://example.com",
  "pages":   [ { "path": "/pricing", "title": "Pricing", "summary": "..." } ],
  "forms":   [ { "page": "/signup",  "fields": ["email","password"], "action": "POST /api/register" } ],
  "actions": [ { "label": "Buy Now", "type": "button", "leads_to": "/checkout" } ],
  "auth":    { "required": true, "method": "JWT" },
  "api_hints": ["/api/search", "/api/products"]
}
```

The AI can now **read any page**, **submit any form**, **click any button** — all as clean function calls, no HTML required.

**How to use it:**
```python
from sitemap.src import SiteMap

awareness = SiteMap.build_sync("https://example.com")
print(awareness.model_dump_json(indent=2))
```

**Full docs:** [`sitemap/README.md`](./sitemap/README.md)

---

## 📁 FileLens

**Problem:** AI gets a whole file dumped into context. For a 2,000-line codebase that means 1,900 lines of irrelevant code burying the 100 lines that matter.

**What FileLens does:** Gives the AI four targeted modes so it reads like a senior engineer — structure first, then only the section it needs.

```
File  →  outline()  →  know the structure  →  chunk() / search()  →  read only what matters
```

**Four modes:**

| Mode | When to use | What you get |
|---|---|---|
| `outline()` | **Always first** — costs nothing | Every class, function, heading + line numbers |
| `search()` | Know what you want, not where it is | Matching lines + surrounding context |
| `chunk()` | Know exactly which lines to read | That line range, numbered |
| `summarize()` | Never seen the file before | Outline + first 40 + last 20 lines |

**Example flow:**
```python
from filelens.src import FileLens

lens = FileLens("auth.py")

# 1. What's in here?
print(lens.outline().render())
# → class UserAuth  lines 18–120
#     ├── login()   line 34
#     └── logout()  line 89

# 2. Read just the login method
print(lens.chunk(34, 55))

# 3. Or search for something specific
for r in lens.search("token expired"):
    print(r.render())
```

**Full docs:** [`filelens/README.md`](./filelens/README.md)

---

## How they relate

Same principle, different data source:

|                | SiteMap                  | FileLens              |
|----------------|--------------------------|-----------------------|
| **Input**      | URL                      | File path             |
| **Map**        | Site Awareness Object    | File outline          |
| **Navigate**   | Page / action lookup     | Line range / search   |
| **Fetch**      | Clean page Markdown      | Targeted chunk        |
| **Act**        | Submit form / call API   | Edit specific section |

Both are designed to be called as **AI agent tools** — not used at a terminal by a human.

---

## Repo layout

```
groundwork/
├── OVERVIEW.md              ← you are here
├── README.md                ← project landing page
├── docs/design.md           ← architecture + philosophy
├── sitemap/
│   ├── README.md            ← full SiteMap docs
│   └── src/
│       ├── sitemap.py       ← SiteMap.build(url)  ← start here
│       ├── models.py        ← SiteAwarenessObject, Page, Form, Action
│       ├── crawler.py       ← Playwright route discovery
│       ├── parser.py        ← forms, buttons, auth detection
│       └── extractor.py     ← HTML → clean Markdown
└── filelens/
    ├── README.md            ← full FileLens docs
    └── src/
        ├── filelens.py      ← FileLens(path) — 4 modes  ← start here
        ├── outline.py       ← structure scanner
        ├── search.py        ← keyword + regex search
        └── summarize.py     ← outline + head + tail
```
