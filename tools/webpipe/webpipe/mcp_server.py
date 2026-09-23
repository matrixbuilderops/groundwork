import sys
import json
import os
import time
import base64
import traceback
import urllib.request
import websocket

# Ensure webpipe directory is in path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from webpipe.pipe import WebPipe
from webpipe.logger import WebPipeLogger

class WebPipeMCPServer:
    """
    Stdio Model Context Protocol (MCP) Server for WebPipe.
    Exposes headless browser streaming, DOM extraction, API interception,
    page inspection, and hardware input actions as native MCP tools to the model.
    """

    def __init__(self):
        self.logger = WebPipeLogger()
        self.pipe = WebPipe(logger=self.logger, interactive=False)

    def list_tools(self):
        return [
            {
                "name": "webpipe_get",
                "description": "Stream clean, unbloated text and captured API payloads from any URL headlessly with live authenticated credentials.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "The URL to navigate to and stream content from."},
                        "wait_seconds": {"type": "integer", "default": 3, "description": "Wait time in seconds for SPA rendering (default: 3)."}
                    },
                    "required": ["url"]
                }
            },
            {
                "name": "webpipe_json",
                "description": "Query a target URL and extract structured data, raw text, and captured background API JSON responses.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "Target URL to inspect."},
                        "wait_seconds": {"type": "integer", "default": 3, "description": "Wait time in seconds (default: 3)."}
                    },
                    "required": ["url"]
                }
            },
            {
                "name": "webpipe_inspect_tab",
                "description": "Inspect open tabs on Chrome CDP, read live document text, page title, URL, or evaluate a JS expression in the tab context.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tab_id": {"type": "string", "description": "Target tab ID. If omitted, lists all open tabs."},
                        "port": {"type": "integer", "default": 9225, "description": "CDP port (default 9225)."},
                        "eval_js": {"type": "string", "description": "Optional JS expression to evaluate in the tab."}
                    }
                }
            },
            {
                "name": "webpipe_action",
                "description": "Perform DOM/CDP actions (click, type, navigate, screenshot, scroll, wait) on a tab without ad-hoc scripts or token bloat.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tab_id": {"type": "string", "description": "Target tab ID or partial URL match."},
                        "action": {"type": "string", "enum": ["click", "type", "navigate", "screenshot", "scroll", "wait"], "description": "Action to execute."},
                        "selector": {"type": "string", "description": "CSS selector to target for click, type, or wait."},
                        "text": {"type": "string", "description": "Text to type, or button text to match for click."},
                        "url": {"type": "string", "description": "Target URL for navigate action."},
                        "output_path": {"type": "string", "description": "File path to save screenshot."},
                        "port": {"type": "integer", "default": 9225, "description": "CDP port (default 9225)."},
                        "wait_after_seconds": {"type": "number", "default": 1.0, "description": "Seconds to wait after action."}
                    },
                    "required": ["tab_id", "action"]
                }
            },
            {
                "name": "webpipe_files",
                "description": ("List every file input on the page and the filename actually "
                                "attached to it. Use before any application submit: upload "
                                "bodies are multipart and cannot be verified on the wire, so "
                                "the filename is the only evidence of WHICH resume goes out."),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tab_id": {"type": "string", "description": "Target tab id"},
                        "port": {"type": "number", "description": "CDP port (default 9225)"},
                    },
                    "required": ["tab_id"],
                },
            },
            {
                "name": "webpipe_extract_form",
                "description": "Extract structured form fields (inputs, labels, values, buttons) in token-minimal JSON from any tab.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tab_id": {"type": "string", "description": "Target tab ID or partial URL match."},
                        "port": {"type": "integer", "default": 9225, "description": "CDP port (default 9225)."}
                    },
                    "required": ["tab_id"]
                }
            },
            {
                "name": "webpipe_logs",
                "description": "Inspect recent WebPipe audit trail events, check page state, or wipe the session log.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "default": 15, "description": "Number of recent events to return."},
                        "wipe": {"type": "boolean", "default": False, "description": "Set to true to wipe the session log."}
                    }
                }
            }
        ]

    def _connect_tab(self, port, tab_id):
        tabs_url = f"http://127.0.0.1:{port}/json"
        with urllib.request.urlopen(tabs_url, timeout=3) as r:
            tabs = json.loads(r.read().decode())
        target_tab = next((t for t in tabs if t["id"] == tab_id or tab_id in t.get("url", "")), None)
        if not target_tab:
            raise ValueError(f"Tab '{tab_id}' not found on port {port}.")
        ws_url = target_tab.get("webSocketDebuggerUrl")
        if not ws_url:
            raise ValueError(f"No WebSocket URL available for tab '{tab_id}' on port {port}.")
        ws = websocket.create_connection(ws_url, timeout=12)
        return ws, target_tab

    def _call_cdp(self, ws, method, params=None, msg_id=1, timeout=8):
        ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                raw = ws.recv()
                if not raw:
                    continue
                data = json.loads(raw)
                if data.get("id") == msg_id:
                    return data
            except websocket.WebSocketTimeoutException:
                pass
            except Exception:
                pass
        raise TimeoutError(f"CDP call {method} (id={msg_id}) timed out after {timeout}s")

    @staticmethod
    def _verdict_banner(verdict, wire):
        """
        One line the caller cannot miss. A page that was blocked must never
        read as a page that was fetched -- that is the failure that puts a row
        in the tracker for an application that never went through.
        """
        res = verdict.get("resolution", "UNDETERMINED")
        port = wire.get("driven_on_port")
        where = "headed :9225" if port == 9225 else "headless :9226"
        if verdict.get("verified"):
            token = (verdict.get("truth_token") or {}).get("truthToken", "-")
            line = f"{res} [{where}] status={wire.get('doc_status')} token={token}"
            notes = [p["type"] for p in verdict.get("paradoxes", [])]
            if notes:
                line += f" | notes: {', '.join(notes)}"
            return line
        kinds = ", ".join(p["type"] for p in verdict.get("paradoxes", [])) or res
        reason = wire.get("challenge_reason") or ""
        return (f"!! NOT VERIFIED [{where}] {res} -- {kinds}"
                + (f" | {reason}" if reason else "")
                + "\n!! Treat this content as UNTRUSTED: it may be a bot wall or "
                  "a login page, not the page requested.")

    def handle_call_tool(self, name, arguments):
        try:
            if name == "webpipe_get":
                url = arguments.get("url")
                wait = arguments.get("wait_seconds", 3)
                # smart_query: headless first, retry headed if walled, then a
                # deterministic verdict from verifier-mcp. The banner states
                # whether the page is TRUSTWORTHY, so a bot wall or an auth
                # bounce can never be read as a successful fetch.
                res, verdict = self.pipe.smart_query(url, wait_seconds=wait)
                w = res.get("wire", {})
                banner = self._verdict_banner(verdict, w)
                text_out = (
                    f"=== WEBPIPE STREAM: {res['title']} ===\n"
                    f"URL: {res['final_url']}\n"
                    f"{banner}\n"
                    f"Raw DOM: {res['metrics']['raw_dom_bytes']} B -> Clean: {res['metrics']['clean_bytes']} B "
                    f"({res['metrics']['savings_pct']} saved in {res['metrics']['duration_ms']}ms)\n\n"
                    f"{res['clean_content']}"
                )
                return [{"type": "text", "text": text_out}]

            elif name == "webpipe_json":
                url = arguments.get("url")
                wait = arguments.get("wait_seconds", 3)
                res, verdict = self.pipe.smart_query(url, wait_seconds=wait)
                res["verification"] = verdict
                return [{"type": "text", "text": json.dumps(res, indent=2)}]

            elif name == "webpipe_inspect_tab":
                port = arguments.get("port", 9225)
                tab_id = arguments.get("tab_id")
                eval_js = arguments.get("eval_js")

                tabs_url = f"http://127.0.0.1:{port}/json"
                with urllib.request.urlopen(tabs_url, timeout=3) as r:
                    tabs = json.loads(r.read().decode())

                if not tab_id:
                    summary = [
                        {"id": t["id"], "title": t.get("title", ""), "url": t.get("url", "")}
                        for t in tabs if t.get("type") == "page"
                    ]
                    return [{"type": "text", "text": json.dumps(summary, indent=2)}]

                ws, target_tab = self._connect_tab(port, tab_id)
                try:
                    expr = eval_js or "({title: document.title, url: window.location.href, text: document.body.innerText.substring(0, 3000)})"
                    eval_res = self._call_cdp(ws, "Runtime.evaluate", {"expression": expr, "returnByValue": True}, msg_id=1)
                    res_obj = eval_res.get("result", {})
                    if "exceptionDetails" in res_obj:
                        err = res_obj["exceptionDetails"]
                        return [{"type": "text", "text": f"JS Exception: {err.get('text', '')} {err.get('exception', {}).get('description', '')}"}]
                    val = res_obj.get("result", {}).get("value")
                    return [{"type": "text", "text": json.dumps(val, indent=2) if isinstance(val, (dict, list)) else str(val)}]
                finally:
                    ws.close()

            elif name == "webpipe_action":
                tab_id = arguments.get("tab_id")
                port = arguments.get("port", 9225)
                action = arguments.get("action")
                selector = arguments.get("selector", "")
                text = arguments.get("text", "")
                url = arguments.get("url", "")
                out_path = arguments.get("output_path", "")
                wait_after = arguments.get("wait_after_seconds", 1.0)

                ws, target = self._connect_tab(port, tab_id)
                try:
                    res_payload = {"status": "ok", "action": action}

                    # A click is the only action that can submit an application.
                    # Text matching is a case-insensitive substring, so a call
                    # meant for "Next" or "Continue" can land on "Submit" on a
                    # multi-page form. Prompt discipline is not a control: refuse
                    # submit-shaped targets unless the caller explicitly asks for
                    # them, which is the human-confirmed final step.
                    if action == "click":
                        SUBMIT_WORDS = ("submit", "apply now", "send application",
                                        "finish", "confirm application")
                        allow_submit = bool(arguments.get("allow_submit"))
                        probe = f"{selector} {text}".lower()
                        if not allow_submit and any(wd in probe for wd in SUBMIT_WORDS):
                            return [{"type": "text", "text": json.dumps({
                                "status": "refused",
                                "action": "click",
                                "reason": (
                                    "Target looks like a final submit control "
                                    f"({probe.strip()[:60]}). Refused. This is the step the "
                                    "human performs. Pass allow_submit=true only after they "
                                    "have confirmed, or click by a specific selector instead."
                                ),
                            }, indent=2)}]

                        js_code = (
                            f"(function() {{"
                            f"  var sel = {json.dumps(selector)};"
                            f"  var txt = {json.dumps(text)};"
                            f"  var el = sel ? document.querySelector(sel) : null;"
                            f"  if (!el && txt) {{"
                            f"    var all = Array.from(document.querySelectorAll('button, a, input[type=submit], div[role=button], span'));"
                            f"    el = all.find(e => e.innerText && e.innerText.trim().toLowerCase().includes(txt.toLowerCase()));"
                            f"  }}"
                            f"  if (el) {{"
                            f"    el.scrollIntoView({{block: 'center'}});"
                            f"    el.click();"
                            f"    return {{clicked: true, tag: el.tagName, text: el.innerText ? el.innerText.trim().substring(0, 50) : ''}};"
                            f"  }}"
                            f"  return {{clicked: false, error: 'Element not found'}};"
                            f"}})()"
                        )
                        eval_res = self._call_cdp(ws, "Runtime.evaluate", {"expression": js_code, "returnByValue": True}, msg_id=1)
                        val = eval_res.get("result", {}).get("result", {}).get("value") or {}

                        # el.click() is a synthetic event: isTrusted === false.
                        # React wrappers, Semantic UI and most "are you human"
                        # guards reject it, so the click silently does nothing.
                        # If the synthetic path did not take, send a REAL mouse
                        # event at the element's on-screen centre instead.
                        if not val.get("clicked"):
                            box_js = (
                                f"(function() {{"
                                f"  var sel = {json.dumps(selector)};"
                                f"  var txt = {json.dumps(text)};"
                                f"  var el = sel ? document.querySelector(sel) : null;"
                                f"  if (!el && txt) {{"
                                f"    var all = Array.from(document.querySelectorAll("
                                f"      'button, a, input[type=submit], div[role=button], span'));"
                                f"    el = all.find(e => e.innerText && e.innerText.trim()"
                                f"      .toLowerCase().includes(txt.toLowerCase()));"
                                f"  }}"
                                f"  if (!el) return null;"
                                f"  el.scrollIntoView({{block: 'center'}});"
                                f"  var r = el.getBoundingClientRect();"
                                f"  return {{x: r.left + r.width/2, y: r.top + r.height/2,"
                                f"           w: r.width, h: r.height}};"
                                f"}})()"
                            )
                            bres = self._call_cdp(ws, "Runtime.evaluate", {"expression": box_js, "returnByValue": True}, msg_id=2)
                            box = bres.get("result", {}).get("result", {}).get("value")
                            if box and box.get("w", 0) > 0 and box.get("h", 0) > 0:
                                for ev, mid in (("mousePressed", 3), ("mouseReleased", 4)):
                                    self._call_cdp(ws, "Input.dispatchMouseEvent", {
                                        "type": ev, "x": box["x"], "y": box["y"],
                                        "button": "left", "clickCount": 1,
                                    }, msg_id=mid)
                                val = {"clicked": True, "method": "hardware mouse event",
                                       "at": [round(box["x"]), round(box["y"])]}
                            else:
                                val = {"clicked": False,
                                       "error": "element not found, or has zero size / is off-screen"}
                        else:
                            val["method"] = "synthetic click"
                        res_payload["result"] = val

                    elif action == "type":
                        # React (and Vue/Angular) override the `value` setter on
                        # controlled inputs. `el.value = x` therefore updates the
                        # DOM but NOT component state, and the field submits
                        # EMPTY while looking correct on screen. Reach past the
                        # framework to the native prototype setter, call that,
                        # then fire the events the framework listens for.
                        js_code = (
                            f"(function() {{"
                            f"  var sel = {json.dumps(selector)};"
                            f"  var val = {json.dumps(text)};"
                            f"  var el = document.querySelector(sel);"
                            f"  if (!el) return {{typed: false, error: 'Element not found'}};"
                            f"  el.focus();"
                            f"  if (el.isContentEditable) {{"
                        f"    el.textContent = val;"
                        f"    el.dispatchEvent(new InputEvent('input', {{bubbles: true}}));"
                        f"    el.dispatchEvent(new Event('change', {{bubbles: true}}));"
                        f"    el.dispatchEvent(new Event('blur', {{bubbles: true}}));"
                        f"    return {{typed: true, current_value: el.textContent,"
                        f"             tag: el.tagName, mode: 'contenteditable'}};"
                        f"  }}"
                        f"  var proto = el.tagName === 'TEXTAREA'"
                            f"    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;"
                            f"  var desc = Object.getOwnPropertyDescriptor(proto, 'value');"
                            f"  if (desc && desc.set) {{ desc.set.call(el, val); }}"
                            f"  else {{ el.value = val; }}"
                            f"  el.dispatchEvent(new Event('input', {{ bubbles: true }}));"
                            f"  el.dispatchEvent(new Event('change', {{ bubbles: true }}));"
                            f"  el.dispatchEvent(new Event('blur', {{ bubbles: true }}));"
                            f"  return {{typed: true, current_value: el.value, tag: el.tagName}};"
                            f"}})()"
                        )
                        eval_res = self._call_cdp(ws, "Runtime.evaluate", {"expression": js_code, "returnByValue": True}, msg_id=1)
                        val = eval_res.get("result", {}).get("result", {}).get("value") or {}

                        # READ BACK. "I set it" is not evidence; what the field
                        # holds now is. A mismatch here is the difference between
                        # a submitted application and an empty one.
                        # React reconciliation is batched and asynchronous. Reading
                        # in the same JS turn as the dispatched events sees the value
                        # we just wrote, BEFORE the framework has had a chance to
                        # reject and revert it -- so a field that ends up empty can
                        # still read back as correct. Wait two animation frames plus
                        # a macrotask so the reconciliation has committed first.
                        verify_js = (
                            f"new Promise(function(resolve) {{"
                            f"  requestAnimationFrame(function() {{"
                            f"    requestAnimationFrame(function() {{"
                            f"      setTimeout(function() {{"
                            f"        var el = document.querySelector({json.dumps(selector)});"
                            f"        if (!el) return resolve(null);"
                            f"        var v = el.value;"
                            f"        if (v === undefined && el.isContentEditable) v = el.textContent;"
                            f"        resolve(v === undefined || v === null ? null : String(v));"
                            f"      }}, 60);"
                            f"    }});"
                            f"  }});"
                            f"}})"
                        )
                        vres = self._call_cdp(ws, "Runtime.evaluate",
                                              {"expression": verify_js, "returnByValue": True,
                                               "awaitPromise": True}, msg_id=2)
                        actual = vres.get("result", {}).get("result", {}).get("value")
                        val["verified_value"] = actual
                        val["matches_intent"] = (actual == text)
                        if not val["matches_intent"]:
                            val["warning"] = (
                                f"FIELD NOT COMMITTED: asked for {text!r}, field holds {actual!r}. "
                                "Do not submit."
                            )
                        res_payload["result"] = val

                    elif action == "navigate":
                        self._call_cdp(ws, "Page.enable", msg_id=1)
                        nav_res = self._call_cdp(ws, "Page.navigate", {"url": url}, msg_id=2)
                        res_payload["result"] = nav_res.get("result", {})

                    elif action == "screenshot":
                        snap_res = self._call_cdp(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=1)
                        data = snap_res.get("result", {}).get("data", "")
                        if data and out_path:
                            os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
                            with open(out_path, "wb") as f:
                                f.write(base64.b64decode(data))
                            res_payload["saved_to"] = out_path
                            res_payload["bytes"] = len(data)
                        else:
                            res_payload["error"] = "Failed to capture or missing output_path"

                    elif action == "scroll":
                        delta_y = arguments.get("delta_y", 500)
                        self._call_cdp(ws, "Runtime.evaluate", {"expression": f"window.scrollBy(0, {delta_y})", "returnByValue": True}, msg_id=1)
                        res_payload["scrolled"] = True

                    elif action == "wait":
                        time.sleep(wait_after)
                        res_payload["waited"] = wait_after

                    if wait_after > 0 and action != "wait":
                        time.sleep(wait_after)

                    return [{"type": "text", "text": json.dumps(res_payload, indent=2)}]
                finally:
                    ws.close()

            elif name == "webpipe_files":
                # The resume is the highest residual risk in an application: its
                # body is multipart and unreadable on the wire, so nothing can
                # confirm WHICH file went out. The browser does expose the
                # attached filename, so surface it explicitly for a human check
                # rather than leaving it invisible.
                tab_id = arguments.get("tab_id")
                port = arguments.get("port", 9225)
                ws, target = self._connect_tab(port, tab_id)
                try:
                    js = ("(function(){var out=[];"
                          "document.querySelectorAll('input[type=file]').forEach(function(el){"
                          "  var names=[];"
                          "  if(el.files){for(var i=0;i<el.files.length;i++)"
                          "    names.push(el.files[i].name+' ('+el.files[i].size+' bytes)');}"
                          "  var lbl=(el.labels&&el.labels[0]?el.labels[0].innerText:'')||"
                          "          el.getAttribute('aria-label')||el.name||el.id||'';"
                          "  out.push({label:String(lbl).trim().substring(0,60),"
                          "            attached:names,"
                          "            nearby_text:(el.parentElement?String(el.parentElement.innerText)"
                          "              .trim().substring(0,120):'')});});"
                          "return JSON.stringify({file_inputs:out});})()")
                    r = self._call_cdp(ws, "Runtime.evaluate",
                                       {"expression": js, "returnByValue": True}, msg_id=1)
                    val = r.get("result", {}).get("result", {}).get("value", "{}")
                    try:
                        parsed = json.loads(val)
                    except Exception:
                        parsed = {"file_inputs": [], "raw": val}
                    parsed["human_check_required"] = (
                        "Confirm this filename is the resume you intend to send. "
                        "The upload body is multipart and cannot be verified on the wire."
                    )
                    return [{"type": "text", "text": json.dumps(parsed, indent=2)}]
                finally:
                    try: ws.close()
                    except Exception: pass

            elif name == "webpipe_extract_form":
                tab_id = arguments.get("tab_id")
                port = arguments.get("port", 9225)
                ws, target = self._connect_tab(port, tab_id)
                try:
                    js_code = """
                    (() => {
                        const fields = [];
                        const elements = Array.from(document.querySelectorAll('input, textarea, select, button'));
                        for (const el of elements) {
                            if (el.type === 'hidden') continue;
                            const tag = el.tagName.toLowerCase();
                            const type = el.type || 'text';
                            
                            let label = '';
                            if (el.id) {
                                const lbl = document.querySelector(`label[for="${el.id}"]`);
                                if (lbl) label = lbl.innerText.trim();
                            }
                            if (!label) {
                                const parentLabel = el.closest('label');
                                if (parentLabel) label = parentLabel.innerText.trim();
                            }
                            if (!label) {
                                label = el.getAttribute('aria-label') || el.placeholder || el.name || '';
                            }
                            
                            fields.push({
                                tag: tag,
                                type: type,
                                id: el.id || '',
                                name: el.name || '',
                                label: label.substring(0, 100),
                                value: tag === 'button' ? el.innerText.trim() : (el.value || ''),
                                checked: el.checked || false,
                                disabled: el.disabled || false,
                                required: el.required || false
                            });
                        }
                        return {
                            title: document.title,
                            url: window.location.href,
                            total_fields: fields.length,
                            fields: fields
                        };
                    })()
                    """
                    eval_res = self._call_cdp(ws, "Runtime.evaluate", {"expression": js_code, "returnByValue": True}, msg_id=1)
                    val = eval_res.get("result", {}).get("result", {}).get("value")
                    return [{"type": "text", "text": json.dumps(val, indent=2)}]
                finally:
                    ws.close()

            elif name == "webpipe_logs":
                if arguments.get("wipe"):
                    self.logger.wipe_session()
                    return [{"type": "text", "text": "Session log wiped successfully."}]
                
                limit = arguments.get("limit", 15)
                log_path = self.logger.log_path
                if not os.path.exists(log_path):
                    return [{"type": "text", "text": "No logs found."}]
                with open(log_path, "r", encoding="utf-8") as f:
                    lines = [line.strip() for line in f if line.strip()]
                return [{"type": "text", "text": "\n".join(lines[-limit:])}]

            else:
                return [{"type": "text", "text": f"Unknown tool: {name}"}]

        except Exception as e:
            return [{"type": "text", "text": f"Error executing {name}: {str(e)}\n{traceback.format_exc()}"}]

    def run(self):
        """Standard JSON-RPC 2.0 loop over stdin/stdout."""
        while True:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                
                req = json.loads(line)
                req_id = req.get("id")
                method = req.get("method")
                params = req.get("params", {})

                if method == "initialize":
                    res = {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {
                            "protocolVersion": "2024-11-05",
                            "capabilities": {
                                "tools": {}
                            },
                            "serverInfo": {
                                "name": "webpipe-mcp-server",
                                "version": "1.0.0"
                            }
                        }
                    }
                    sys.stdout.write(json.dumps(res) + "\n")
                    sys.stdout.flush()

                elif method == "notifications/initialized":
                    pass

                elif method == "tools/list":
                    res = {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {
                            "tools": self.list_tools()
                        }
                    }
                    sys.stdout.write(json.dumps(res) + "\n")
                    sys.stdout.flush()

                elif method == "tools/call":
                    name = params.get("name")
                    args = params.get("arguments", {})
                    content = self.handle_call_tool(name, args)
                    res = {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {
                            "content": content
                        }
                    }
                    sys.stdout.write(json.dumps(res) + "\n")
                    sys.stdout.flush()

                else:
                    if req_id is not None:
                        res = {
                            "jsonrpc": "2.0",
                            "id": req_id,
                            "error": {
                                "code": -32601,
                                "message": f"Method '{method}' not found"
                            }
                        }
                        sys.stdout.write(json.dumps(res) + "\n")
                        sys.stdout.flush()

            except Exception as e:
                pass

if __name__ == "__main__":
    server = WebPipeMCPServer()
    server.run()
