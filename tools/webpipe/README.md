# WebPipe — Direct Web-to-Model Data Streaming Pipe

> **The Model Proposes; Deterministic Executed Data Owns the Verdict.**

WebPipe connects directly to your persistent, authenticated Chrome browser session via Chrome DevTools Protocol (CDP). Instead of feeding models 100KB+ bloated, ad-polluted HTML DOM trees, WebPipe intercepts raw internal JSON API streams, strips markup noise, and delivers pure, token-efficient structured payloads.

If a security challenge, Cloudflare Turnstile, or 2FA checkpoint is encountered, WebPipe immediately pauses, activates the browser window to your screen, and waits for you to clear the wall before automatically resuming.

---

## Key Capabilities

1. **Persistent Session & Saved Credentials:** Attaches to your real running Chrome profile (e.g., `--user-data-dir=~/.creds-sorrell` on port `9225`). No throwaway browser sessions, zero bot-detection red flags.
2. **Network JSON API Interception:** Monitors network response bodies (`Network.getResponseBody`). When modern SPAs (React, Vue, Next.js) load data via internal API endpoints, WebPipe grabs the raw JSON payload directly.
3. **High-Signal Clean Extractor:** Strips scripts, styles, svgs, navigation, cookie banners, and tracking tags. Typically saves 75%–95% in token consumption and context window clutter.
4. **Human-in-the-Loop Auth Resolver:**
   - Detects login walls, CAPTCHAs, and Cloudflare challenges automatically.
   - Activates the tab front-and-center on your screen.
   - Prompts you cleanly in terminal to sign in, then resumes automatically upon clearance.
5. **Deterministic JSONL Audit Trail:** Logs every request start, auth barrier, resolution time, bandwidth savings, and captured payload count to `audit.jsonl`.

---

## Architecture Diagram

```
[Target Website] 
       │ (JSON API / HTML)
       ▼
[Persistent Chrome Profile (:9225)] ── Auth Check ──> [Cloudflare / Login Barrier?]
       │                                                      │
       │ (CDP WebSocket)                                     YES: Activate Tab & Prompt User
       ▼                                                      │
[WebPipe Engine]                                              NO: Continue
       ├─► Network Interceptor (Pure JSON API Payloads)
       ├─► Clean Extractor (75-95% Token Savings)
       └─► Audit Trail (audit.jsonl)
       │
       ▼
[AI Model / Local CLI Pipe]
```

---

## CLI Usage

### Check Connection & Active Tabs
```bash
python3 webpipe_cli.py check
```

### Stream Clean Web Content
```bash
python3 webpipe_cli.py get https://example.com
```

### Extract Structured Data & Captured API Payloads as JSON
```bash
python3 webpipe_cli.py json https://example.com --save output.json
```

### Inspect JSONL Audit Logs
```bash
python3 webpipe_cli.py logs -n 10
```

---

## Model Context Protocol (MCP) Server Integration

WebPipe ships as a native stdio Model Context Protocol (MCP) server. Instead of agents executing repetitive `python3 -c "..."` bash one-liners that blow up prompt tokens, hang terminals, or trigger watchdog kills, the model communicates directly with WebPipe over JSON-RPC:

Registered in `~/.gemini/config/mcp_config.json`:
```json
{
  "mcpServers": {
    "webpipe": {
      "command": "/usr/local/bin/python3",
      "args": [
        "/Users/broodierchip-m1air/Desktop/matrixbuilderops/tools/webpipe/webpipe/mcp_server.py"
      ],
      "env": {
        "PYTHONUNBUFFERED": "1"
      }
    }
  }
}
```

### 6 Native MCP Tools Available to Models:
1. `webpipe_get(url, wait_seconds)`: Headless markdown/text extraction with live authentication cookies.
2. `webpipe_json(url, wait_seconds)`: Intercepts SPA internal JSON API payloads + structured DOM metrics.
3. `webpipe_inspect_tab(tab_id, port, eval_js)`: Reads tab state, title, URL, or evaluates inline JS.
4. `webpipe_action(tab_id, action, selector, text, url, output_path)`: Pure CDP execution for `click`, `type`, `navigate`, `screenshot`, `scroll`, and `wait` with zero script bloat.
5. `webpipe_extract_form(tab_id, port)`: Extracts form inputs, types, labels, values, and submit buttons in under 300 tokens of structured JSON.
6. `webpipe_logs(limit, wipe)`: Inspects recent audit events, verifies state (`is_signed_in`, `auth_barrier`), or wipes session logs.

---

## Log Management & Rotation
- **Rolling Logs:** Automatically caps audit logs at 10MB and rotates up to 5 backups (`audit.jsonl.1`, etc.).
- **On-Demand Wipe:**
  ```bash
  python3 webpipe_cli.py logs --wipe      # Clear current session
  python3 webpipe_cli.py logs --wipe-all  # Clear all rotated logs
  ```
