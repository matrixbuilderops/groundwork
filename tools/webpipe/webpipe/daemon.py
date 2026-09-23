import os
import subprocess
import time
import urllib.request
import json
import websocket

HEADLESS_PORT = 9226
HEADLESS_DATA_DIR = os.path.expanduser("~/.creds-headless")

STEALTH_INJECTION_JS = """
// 1. Remove automation / webdriver signals
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
window.chrome = { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };

// 2. Realistic plugins and languages
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

// 3. Hardware concurrency & memory
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

// 4. Permissions API query mock
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications' ?
    Promise.resolve({ state: Notification.permission }) :
    originalQuery(parameters)
);
"""

CLEAN_MAC_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"

class HeadlessDaemon:
    def __init__(self, headless_port=HEADLESS_PORT, headed_port=9225):
        self.headless_port = headless_port
        self.headed_port = headed_port
        self._proc = None

    def is_running(self):
        try:
            url = f"http://127.0.0.1:{self.headless_port}/json/version"
            with urllib.request.urlopen(url, timeout=2) as r:
                return r.status == 200
        except Exception:
            return False

    def ensure_running(self):
        if self.is_running():
            # The daemon outlives any single request, so a sync done at birth goes
            # stale as soon as a session rotates on the headed browser. Re-pull the
            # live cookie jar from :9225 on every use, not just at startup --
            # otherwise long-lived daemons silently fall back to logged-out.
            self.sync_cookies_from_headed()
            return True

        os.makedirs(HEADLESS_DATA_DIR, exist_ok=True)
        cmd = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "--headless=new",
            f"--remote-debugging-port={self.headless_port}",
            "--remote-allow-origins=*",
            f"--user-data-dir={HEADLESS_DATA_DIR}",
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank"
        ]
        self._proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        for _ in range(15):
            time.sleep(0.5)
            if self.is_running():
                self.sync_cookies_from_headed()
                return True

        raise RuntimeError(f"Failed to start silent headless Chrome daemon on port {self.headless_port}")

    def get_headed_ws_url(self):
        try:
            url = f"http://127.0.0.1:{self.headed_port}/json/version"
            with urllib.request.urlopen(url, timeout=2) as r:
                return json.loads(r.read().decode())["webSocketDebuggerUrl"]
        except Exception:
            return None

    def get_headless_ws_url(self):
        try:
            url = f"http://127.0.0.1:{self.headless_port}/json/version"
            with urllib.request.urlopen(url, timeout=2) as r:
                return json.loads(r.read().decode())["webSocketDebuggerUrl"]
        except Exception:
            return None

    def read_headed_storage(self, origin):
        """
        Read localStorage for `origin` out of the headed browser.

        Cookies are only half of where a browser keeps a session. Clerk, Auth0
        and most modern SPAs keep theirs in localStorage, so Network.setCookies
        can move all 698 cookies and still land on a login page -- measured:
        the headed profile held a 30KB `user` object, the headless one held 4
        bytes. This reads the other half.

        Only reads from a tab the headed browser ALREADY has open on that
        origin. It never opens one, because opening a tab can pull the window
        forward and this runs on every query. If no such tab exists, it returns
        (False, ...) and the caller carries on -- the normal auth-barrier flow
        opens the page, and once that tab exists this works on the next run.

        The returned values are live session credentials. They stay in memory:
        never logged, never written to audit.jsonl, never persisted.
        """
        try:
            tabs = json.loads(
                urllib.request.urlopen(f"http://127.0.0.1:{self.headed_port}/json", timeout=5).read()
            )
        except Exception as e:
            return False, {"error": f"headed browser unreachable: {e}"}

        candidates = [
            t for t in tabs
            if t.get("type") == "page" and (t.get("url") or "").startswith(origin)
        ]
        if not candidates:
            return False, {"error": f"no headed tab open on {origin}"}

        for tab in candidates:
            try:
                ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=8)
                ws.send(json.dumps({
                    "id": 1,
                    "method": "Runtime.evaluate",
                    "params": {
                        "expression": (
                            "(()=>{try{const o={};for(let i=0;i<localStorage.length;i++)"
                            "{const k=localStorage.key(i);o[k]=localStorage.getItem(k);}"
                            "return JSON.stringify(o);}catch(e){return '{}';}})()"
                        ),
                        "returnByValue": True,
                    },
                }))
                res = json.loads(ws.recv())
                ws.close()
                raw = res.get("result", {}).get("result", {}).get("value", "{}")
                data = json.loads(raw)
                if data:
                    return True, data
            except Exception:
                continue
        return False, {"error": f"could not read storage from any {origin} tab"}

    @staticmethod
    def storage_seed_script(origin, storage):
        """
        A document-start script that restores localStorage for one origin.

        Injected via Page.addScriptToEvaluateOnNewDocument so it runs BEFORE the
        page's own JS reads the session -- setting it afterwards is too late,
        the app has already decided it is logged out. Guarded on origin so the
        values can never leak onto another site.
        """
        return (
            "(()=>{try{"
            f"if(location.origin!=={json.dumps(origin)})return;"
            f"const d={json.dumps(storage)};"
            "for(const k in d){try{localStorage.setItem(k,d[k]);}catch(e){}}"
            "}catch(e){}})();"
        )

    def sync_cookies_from_headed(self):
        headed_ws_url = self.get_headed_ws_url()
        headless_ws_url = self.get_headless_ws_url()

        if not headed_ws_url or not headless_ws_url:
            return 0

        try:
            ws_headed = websocket.create_connection(headed_ws_url, timeout=5)
            ws_headed.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
            res = json.loads(ws_headed.recv())
            raw_cookies = res.get("result", {}).get("cookies", [])
            ws_headed.close()

            if not raw_cookies:
                return 0

            clean_cookies = []
            for c in raw_cookies:
                cookie_item = {
                    "name": c["name"],
                    "value": c["value"],
                    "domain": c.get("domain", ""),
                    "path": c.get("path", "/"),
                    "secure": c.get("secure", False),
                    "httpOnly": c.get("httpOnly", False),
                }
                if "sameSite" in c and c["sameSite"] in ["Strict", "Lax", "None"]:
                    cookie_item["sameSite"] = c["sameSite"]
                if "expires" in c and c["expires"] > 0:
                    cookie_item["expires"] = c["expires"]
                clean_cookies.append(cookie_item)

            ws_headless = websocket.create_connection(headless_ws_url, timeout=5)
            ws_headless.send(json.dumps({"id": 1, "method": "Network.enable"}))
            ws_headless.recv()

            batch_size = 50
            for i in range(0, len(clean_cookies), batch_size):
                batch = clean_cookies[i:i + batch_size]
                ws_headless.send(json.dumps({
                    "id": 100 + i,
                    "method": "Network.setCookies",
                    "params": {"cookies": batch}
                }))
                ws_headless.recv()

            ws_headless.close()
            return len(clean_cookies)

        except Exception as e:
            return 0

    def apply_stealth_to_ws(self, target_ws):
        """Applies stealth overrides to target tab before navigation."""
        try:
            # 1. Page-level script injection
            target_ws.send(json.dumps({
                "id": 8901,
                "method": "Page.addScriptToEvaluateOnNewDocument",
                "params": {"source": STEALTH_INJECTION_JS}
            }))
            target_ws.recv()

            # 2. Clean User-Agent override
            target_ws.send(json.dumps({
                "id": 8902,
                "method": "Network.setUserAgentOverride",
                "params": {
                    "userAgent": CLEAN_MAC_USER_AGENT,
                    "acceptLanguage": "en-US,en;q=0.9",
                    "platform": "MacIntel"
                }
            }))
            target_ws.recv()
            return True
        except Exception:
            return False
