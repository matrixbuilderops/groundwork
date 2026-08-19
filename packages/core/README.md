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

Measured over five live pages: level 1 answered 1 of 5, level 2 answered 4 of 5,
together 5 of 5. Neither is sufficient alone — that is why it is a ladder.

```
                       raw HTML    as prose   answered by   fields
news.ycombinator.com     35 KB       4.1 KB     level 2        522
bbc.com/news            383 KB      10.5 KB     level 1      2,877
pypi.org/project/requests 182 KB    12.1 KB     level 2        596
github.com/…/anthropic-sdk-python 317 KB 4.6 KB level 2        223
developer.mozilla.org/…/Headers   292 KB 48.2 KB level 2        948
```

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
