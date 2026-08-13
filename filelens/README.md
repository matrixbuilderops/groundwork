# FileLens

**Intelligent file reading for AI agents.**

> *"Don't dump a file. Understand it."*

---

## What is FileLens?

When an AI agent needs to work with a file, the naive approach is to read the whole thing — `cat file.py` — and dump every line into the context window. For small files this works. For anything real — a 2,000-line class, a 500-line config, a codebase — it wastes context, buries the relevant content, and forces the AI to scan noise to find signal.

FileLens solves this by doing what a senior engineer does when they open an unfamiliar file: **read the structure first, then go to exactly the right place.**

FileLens gives an AI agent four targeted modes. The AI always starts with `outline()` — a free, fast structural scan that tells it exactly where everything lives. Then it uses `search()`, `chunk()`, or `summarize()` to get only what it actually needs.

---

## Four modes

### `outline()` — What is the structure of this file?

Always call this first. It scans the file and returns every class, function, method, and heading with its line numbers — for almost no cost. The AI reads this map and decides exactly which lines to fetch next.

```
file.py  (843 lines, Python)
├── class UserAuth  lines 18–120
│   ├── __init__()  line 19
│   ├── login()     line 34
│   └── logout()    line 89
├── class Database  lines 123–400
└── main()          lines 403–843
```

Supports: Python, JavaScript, TypeScript, Markdown. Falls back gracefully for other types.

---

### `search()` — Where is X in this file?

Keyword or regex search that returns matching lines plus surrounding context. Use this when you know what you're looking for but not where it is.

```python
results = lens.search("def login", context_lines=5)
for r in results:
    print(r.render())
```

Output:
```
  32 │     def __init__(self, db):
  33 │         self.db = db
▶ 34 │     def login(self, email, password):
  35 │         return self.db.check(email, password)
  36 │
```

---

### `chunk()` — Give me lines N to M.

Precise line-range extraction. Use after `outline()` or `search()` tells you exactly which lines to read. Lines are 1-indexed and inclusive.

```python
print(lens.chunk(34, 89))   # Read the entire login() method
```

Output:
```
   34 │     def login(self, email, password):
   35 │         return self.db.check(email, password)
   ...
   89 │     def logout(self, user_id):
```

---

### `summarize()` — What does this file do?

Combines the outline + first 40 lines + last 20 lines into one readable block. No LLM required — fast and offline. Use this when you've never seen the file before and need a full picture in one call.

```python
print(lens.summarize())
```

Output:
```
FILE: userauth.py
LANGUAGE: Python
SIZE: 843 lines

STRUCTURE:
userauth.py  (843 lines, Python)
├── class UserAuth  lines 18–120
...

HEAD (first 40 lines):
import os
...
```

---

## Usage

```python
from filelens.src import FileLens

lens = FileLens("path/to/file.py")

# Step 1 — always start here
outline = lens.outline()
print(outline.render())

# Step 2a — find something specific
results = lens.search("def login")

# Step 2b — or get a full picture
print(lens.summarize())

# Step 3 — read only what you need
print(lens.chunk(34, 89))
```

### The workflow every AI agent should follow

```
outline()          ← What's in here? Where does everything live?
    │
    ├─ search()    ← I know what I want, find it
    │       └─ chunk()   ← Now read that exact section
    │
    └─ summarize() ← I've never seen this file, give me the full picture
            └─ chunk()   ← Now read the part that matters
```

---

## File structure

```
filelens/
├── src/
│   ├── __init__.py     # Exports FileLens
│   ├── filelens.py     # Main entry point — FileLens class, all 4 modes
│   ├── outline.py      # Structure scanner (Python, JS/TS, Markdown)
│   ├── search.py       # Keyword + regex search with context
│   └── summarize.py    # Outline + head + tail summary
├── tests/
│   └── test_filelens.py
└── pyproject.toml
```

---

## Install

```bash
pip install -e ./filelens
```

---

## Also in this repo

**[SiteMap](../sitemap/)** does for websites what FileLens does for files.
Instead of dumping raw HTML into an AI's context, SiteMap crawls a URL and
returns a structured Site Awareness Object — every page, form, button, and
API endpoint — so the AI can navigate and interact with the site without
ever seeing raw HTML. Same principle, different data source.
