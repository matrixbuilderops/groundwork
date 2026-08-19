# @groundwork/core

The extraction engine shared by the groundwork packages. Turns a page into the
data it was rendered from, instead of into prose about that data.

## Why

`sitemap-mcp` renders HTML to clean text. That is a real improvement over raw
DOM, but it is lossy in a specific way: a listing page is one template applied
to N rows, and flattening it to prose destroys the fact that the rows are the
same shape. It also strips `<script>` before reading — which is where
server-rendered frameworks put the page's entire data model.

This engine recovers both.

## The ladder

Cost-ordered. The first rung that answers wins.

| | Level | Cost | Recovers |
|---|---|---|---|
| 1 | embedded JSON | free | `ld+json`, `__NEXT_DATA__`, `__NUXT_DATA__`, hydration blobs |
| 2 | template detection | free | repeated structure → schema + records |
| 3 | headless render | seconds | content that exists only after JS runs |
| 4 | credentialed browser | seconds | pages behind a login or bot wall |

Levels 3 and 4 need a browser and live in `packages/browser`. This package owns
1 and 2, and sets `requiresAuth` when a page needs the rungs above.

Neither rung is sufficient alone — that is why it is a ladder.

## Measured

Twelve live pages, chosen to include cases meant to break it:

```
                          level  kind      conf   top template
crates.io                 —      empty     0.00   — (SPA, needs level 3)
excalidraw.com            —      empty     0.00   — (SPA, needs level 3)
example.com               —      empty     0.00   —
wikipedia.org/…/HTTP      2      document  0.68   li×70
react.dev/learn           2      index     0.82   div.max-w-4xl×6      ← weak
lemonde.fr                2      document  0.64   section.autopromo__item×8
simonwillison.net/…       2      document  0.42   tr×6
news.ycombinator.com      2      index     0.60   tr×31
github.com/…/sdk-python   2      index     0.80   tr.react-directory-row×16
pypi.org/project/requests 2      index     0.83   div.release×161
openlibrary.org/search    2      index     1.00   li.searchResultItem×20
bbc.com/news              1      index     1.00   ld+json + __NEXT_DATA__
```

Eleven of twelve are classified correctly. `react.dev/learn` is a documentation
page reported as an index — a real miss, and the reason `confidence` is part of
the output rather than an internal.

The two SPAs returning nothing is the honest answer, not a failure: neither ships
server-rendered content, so only level 3 can read them.

## Code outlines

`detectLanguage` in filelens names 28 extensions; its `buildOutline` dispatches
on four. A `.rs` file therefore reported `LANGUAGE: Rust`, a line count, and zero
symbols — indistinguishable from a Rust file that defines nothing.

This package adds scanners for the rest: **Go, Rust, Java, C, C++, C#, Ruby,
Shell**. `outlineCode` returns `null` when no scanner exists, so callers can keep
saying "nothing parsed this" rather than "this defines nothing".

Validated against real source on disk, not fixtures:

```
sph_echo.c          1,033 lines   28 symbols   (ground truth: 28)
DmiReader.cpp         136 lines    6 symbols   (ground truth: 6)
lib.rs                219 lines   14 symbols   nested mod > impl > fn
build_api_docs.rb     238 lines   10 symbols
authorizer_test.go    472 lines    2 symbols   (the file has one top-level func)
```

Three defects only real files exposed:

- **C splits declarations across lines.** `static void` on one line, the name and
  arguments on the next. A single-line regex found 0 of 28 functions.
- **Trailing qualifiers.** `toJSON(...) const {` — looking for `{` immediately
  after `)` missed every const method.
- **Constructor initialiser lists.** `: m_a(a), m_b(b)` is an identifier, a
  balanced argument list, and then a brace, so `m_a` was reported as a function.

## Use

```bash
npx groundwork-extract https://pypi.org/project/requests/
npx groundwork-extract <url> --json          # full Extraction object
```

```ts
import { extract } from "@groundwork/core";

const r = extract(html, url);
r.level        // 1 | 2 | null — which rung answered
r.fieldCount   // scalar leaves recovered
r.templates    // [{ selector, count, fields, records }]
r.requiresAuth // climb to level 4
```

## Telling data from furniture

Every page repeats something; only some of it is data. A nav bar, a tag cloud,
and a results table are all "repeated siblings". The filter is **variance**:
real records differ field by field, while furniture repeats the same handful of
values. A template whose fields never vary is dropped.

The same care applies to `requiresAuth`. Auth language alone flagged Hacker News
and PyPI, both fully readable, because their navs contain "Sign in" — and would
have escalated healthy pages to the expensive browser. A wall is *thin*: it is
language plus the absence of content, never language alone.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for noncommercial use.
Commercial use requires a paid license: matrixbuilderops@proton.me
