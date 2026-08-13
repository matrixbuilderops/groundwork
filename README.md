# groundwork

**The foundational awareness layer for AI agents.**

Two tools. One principle: give AI a map first, not a data dump.

---

## The problem both tools solve

AI agents are routinely handed raw data and told to figure it out:

- Raw HTML dumps of entire websites
- Entire files read top to bottom with `cat`

This wastes context window, buries signal in noise, and forces the AI to scan everything to find anything. It works on toy examples and fails in the real world.

The fix is the same in both cases: **build a structured map first, then navigate to exactly what's needed.**

That's groundwork.

---

## 🌐 SiteMap — Website awareness for AI

> *"Don't read a website. Know it."*

SiteMap crawls a URL and returns a **Site Awareness Object** — a clean, structured map of every page, form, button, link, and API endpoint on the site. The AI never sees raw HTML. It sees a queryable object it can reason over and act on.

**What the AI gets:**
- Every page with title, summary, and clean Markdown content
- Every form with its fields and submit endpoint
- Every button, link, and input as a callable action
- API endpoints detected from page scripts
- Auth requirement detection

```python
from sitemap.src import SiteMap

awareness = SiteMap.build_sync("https://example.com")
print(awareness.model_dump_json(indent=2))
```

📁 **[Full documentation → sitemap/](./sitemap/)**

---

## 📁 FileLens — Intelligent file reading for AI

> *"Don't dump a file. Understand it."*

FileLens gives AI agents four targeted modes for reading files — instead of dumping the whole thing into context.

| Mode | What it does |
|---|---|
| `outline()` | Scans structure — classes, functions, headings, line numbers. **Always call first.** |
| `search()` | Keyword or regex search with surrounding context lines |
| `chunk()` | Read a precise line range |
| `summarize()` | Outline + head + tail in one shot |

```python
from filelens.src import FileLens

lens = FileLens("path/to/file.py")
print(lens.outline().render())   # What's in here?
print(lens.chunk(34, 89))        # Read just this section
```

📁 **[Full documentation → filelens/](./filelens/)**

---

## Shared design principle

```
Build a map → navigate by query → fetch only what's needed
```

|                | SiteMap               | FileLens              |
|----------------|-----------------------|-----------------------|
| **Map**        | Site Awareness Object | File outline          |
| **Navigate**   | Page / action lookup  | Line range / search   |
| **Fetch**      | Clean page Markdown   | Targeted chunk        |
| **Act**        | Form / API call       | Edit specific section |

Both tools are designed to be called by AI agents as tools — not by humans at a terminal.

---

## Repo structure

```
groundwork/
├── sitemap/           # Website awareness tool
│   ├── src/
│   │   ├── sitemap.py     # Main entry point
│   │   ├── models.py      # Pydantic Site Awareness Object
│   │   ├── crawler.py     # Playwright-based route discovery
│   │   ├── parser.py      # DOM → forms, actions, auth
│   │   └── extractor.py   # HTML → clean Markdown
│   ├── tests/
│   └── pyproject.toml
├── filelens/          # Intelligent file reader
│   ├── src/
│   │   ├── filelens.py    # Main entry point — 4 modes
│   │   ├── outline.py     # Structure scanner
│   │   ├── search.py      # Keyword + regex search
│   │   └── summarize.py   # Outline + head + tail
│   ├── tests/
│   └── pyproject.toml
└── docs/
    └── design.md          # Architecture and philosophy
```

---

## Status

🚧 Active development — `matrixbuilderops/groundwork`
