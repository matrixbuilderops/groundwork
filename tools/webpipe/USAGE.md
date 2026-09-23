# webpipe — how to use it

One command. Everything runs against your real signed-in Chrome on `:9225`.

```
webpipe check              is the browser reachable
webpipe get <url>          clean text + a verdict you can trust
webpipe json <url>         full structured result, including verification
webpipe diag               WHY the last run decided what it decided
webpipe diag --failed      only the runs that hit a wall
webpipe logs -n 10         raw audit trail
```

The launcher lives at `~/.local/bin/webpipe`. No `cd`, no paths to remember.

---

## The one thing to understand

**It reads the wire, not the page.**

The old way decided whether a fetch worked by reading the page: HTTP status
guessed from the `<title>`, "are you logged in" guessed by searching the body
text for phrases like `sign in to upwork`. That is wrong in the exact cases that
cost you money — it reported a 401 auth wall as `200, signed in`, and it missed
a live bot wall because the page said *"confirm you are human"* and the rule
looked for *"verify you are human"*.

This reads the actual network traffic: the real HTTP status, the real request
bodies, the server's own answer. On a controlled benchmark that is **12/12
against 9/12**; on your own sites **12/12 against 10/12**, where both DOM
failures were the two sites that were genuinely blocking you.

**Every answer is one of:**

| verdict | means |
|---|---|
| `VERIFIED` | evidence observed, no contradictions, truth token issued |
| `VERIFIED_WITH_NOTES` | fine, with something worth recording (e.g. a canonical redirect) |
| `PARADOX_BLOCKED` | a contradiction that matters — do not trust this content |
| `UNDETERMINED_*` | no evidence, or the verifier was unreachable |

It never passes on absence of evidence. No truth token means no pass.

---

## Everyday use

```bash
webpipe check                      # is Chrome up
webpipe get https://example.com    # read a page, with a verdict
```

A clean read looks like this:

```
=== WEBPIPE STREAM: Example Domain ===
URL: https://example.com/
VERIFIED [headless :9226] status=200 token=57cb1384f9f71590
Raw DOM: 544 B -> Clean: 127 B (76.65% saved)
```

A blocked one looks like this, and the content is **not** to be trusted:

```
!! NOT VERIFIED [headed :9225] PARADOX_BLOCKED -- CHALLENGE_PARADOX
!! Treat this content as UNTRUSTED: it may be a bot wall or a login page.
```

---

## When something goes wrong

```bash
webpipe diag              # last run
webpipe diag -n 5         # last five
webpipe diag --failed     # only the ones that hit a wall
```

That prints **why**, not just what:

```
  browser      : headed :9225
  landed       : https://www.levels.fyi/login?screen=signIn
  http status  : 200
  challenge    : True  -- redirected to a page with a password field

  why it decided that
    401/403 on document       : no
    challenge vendor resource : no
    redirect + password field : FIRED (redirected=True, password=True)

  document chain
    200 https://idmsa.apple.com/IDMSWebAuth/signin?appIdKey=...

  console
    error: Failed to load resource: net::ERR_FAILED
```

A wrong verdict can be traced to the signal that misfired instead of re-run blind.

---

## Which browser it uses

**Your real Chrome on `:9225` is the default.** It holds your sessions, a real
fingerprint and no bot score. Headless `:9226` exists only as a token
optimisation for public pages and is opt-in per call.

This was the other way round at first, and it was wrong: cookie and localStorage
syncing existed to make a headless browser impersonate a browser already running
on your screen, and it still got served reCAPTCHA. Measured on levels.fyi:
headless got a challenge, headed walked straight in seconds later.

---

## Walls

When a login or CAPTCHA appears:

1. Chrome comes to the front and a notification fires.
2. You solve it. Saved credentials usually autofill, so it is often one click.
3. Focus returns to wherever you were and work resumes in the background.

Focus is borrowed, never taken — it returns on every exit path, including
timeouts and cancellations.

**Known walls right now:** Wellfound and some LinkedIn paths run Cloudflare
Turnstile / reCAPTCHA Enterprise. **LinkedIn rate-limits hard** — two searches
back to back trips it. Pace queries roughly two minutes apart.

---

## In Python

```python
from webpipe.pipe import WebPipe

w = WebPipe(interactive=False)
res, verdict = w.smart_query("https://example.com", wait_seconds=6)

verdict["verified"]      # bool — the only thing worth branching on
verdict["resolution"]    # VERIFIED / PARADOX_BLOCKED / UNDETERMINED_*
verdict["paradoxes"]     # what contradicted what
res["wire"]["doc_status"]  # real HTTP status
res["wire"]["posts_sent"]  # submissions, with bodies and response codes
```

`res["status"]` tracks the verdict — it can never say `SUCCESS` about something
the verdict rejected.

---

## Filling forms

Use the MCP tools (`webpipe_action`, `webpipe_extract_form`, `webpipe_files`),
not raw JS. Two things they handle that hand-written JS does not:

- **`el.value = x` does not work on React forms.** React overrides the setter;
  the field renders your text and submits **empty**. The `type` action uses the
  native prototype setter, then **reads the value back** and tells you
  `matches_intent`. If that is false, the field did not commit — do not submit.
- **`el.click()` is rejected** by handlers checking `isTrusted`. The `click`
  action falls back to a real CDP mouse event.

**Submit-shaped clicks are refused by default.** `click(text="Submit")` and
`click(text="Apply Now")` return `refused` unless `allow_submit=true` is passed
explicitly. That step is yours.

**Before any application submit, run `webpipe_files`.** Upload bodies are
multipart and unreadable on the wire, so the filename is the only evidence of
which résumé actually goes out.

---

## The three packages behind it

| stage | package | role |
|---|---|---|
| before | `sitemap-mcp` | expected structure: pages, forms, API hints |
| during | `webpipe` | observed wire facts in your real browser |
| after | `verifier-mcp` | deterministic verdict + SHA-256 truth token |

Where the structural view and the observed view disagree, that disagreement is
the finding. All three are registered with Antigravity in
`~/.gemini/config/mcp_config.json`.

---

## Bob

```bash
bobchat                 # interactive
bobchat "message"       # one-shot, remembers the conversation
bobchat -n "message"    # start fresh
```

Used here for code review: two passes, $0.38, twelve real bugs found — including
an AppleScript injection hole and one of my own fixes that was dead code. Long
threads replay the whole transcript, so `/new` when the topic changes.
