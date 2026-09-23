import json
import time
import urllib.parse
import urllib.request
import re
import websocket
from .logger import WebPipeLogger
from .auth import AuthDetector, AuthResolver
from .daemon import HeadlessDaemon, HEADLESS_PORT
from .input import HumanInput
from .urlnorm import norm_url as _norm
from . import politeness


def params_type_doc(evt):
    try:
        return evt["params"].get("type") == "Document"
    except Exception:
        return False


def _as_int(v):
    """
    CDP normally reports numeric statuses, but not always -- a string slipped
    through and `status >= 400` raised TypeError, aborting the entire query on
    LinkedIn. A status we cannot read as a number is None (unknown), never a
    value that silently compares wrong.
    """
    try:
        return int(v)
    except (TypeError, ValueError):
        return None

class WebPipe:
    """
    Direct Web-to-Model Data Streaming Pipe.
    Runs 100% invisibly in the background on an actual silent headless Chrome daemon (:9226).
    Synchronizes live session cookies from your desktop profile (:9225) so it is authenticated
    on all your accounts without ever creating a window, tab, or visual flicker on your screen.

    If a CAPTCHA or Login barrier is hit, it hands off to the visible browser (:9225) for human resolution,
    syncs the new cookies back, and continues in total silence.
    """

    def __init__(self, port=HEADLESS_PORT, headed_port=9225, logger=None, interactive=True):
        self.port = port
        self.headed_port = headed_port
        self.logger = logger or WebPipeLogger()
        self.interactive = interactive
        self.daemon = HeadlessDaemon(headless_port=self.port, headed_port=self.headed_port)
        self.resolver = AuthResolver(port=self.headed_port, logger=self.logger)
        self._browser_ws_url = None

    def _ensure_daemon(self):
        self.daemon.ensure_running()

    def _get_browser_ws_url(self):
        self._ensure_daemon()
        if not self._browser_ws_url:
            url = f"http://127.0.0.1:{self.port}/json/version"
            with urllib.request.urlopen(url, timeout=5) as r:
                ver = json.loads(r.read().decode())
                self._browser_ws_url = ver["webSocketDebuggerUrl"]
        return self._browser_ws_url

    def _create_silent_target(self, initial_url="about:blank"):
        b_ws_url = self._get_browser_ws_url()
        b_ws = websocket.create_connection(b_ws_url, timeout=5)
        msg = {
            "id": 1,
            "method": "Target.createTarget",
            "params": {"url": initial_url}
        }
        b_ws.send(json.dumps(msg))
        res = json.loads(b_ws.recv())
        target_id = res.get("result", {}).get("targetId")
        b_ws.close()

        ws_url = f"ws://127.0.0.1:{self.port}/devtools/page/{target_id}"
        return target_id, ws_url

    def _close_silent_target(self, target_id):
        try:
            b_ws_url = self._get_browser_ws_url()
            b_ws = websocket.create_connection(b_ws_url, timeout=5)
            msg = {
                "id": 1,
                "method": "Target.closeTarget",
                "params": {"targetId": target_id}
            }
            b_ws.send(json.dumps(msg))
            b_ws.recv()
            b_ws.close()
            return True
        except Exception:
            return False

    # Generic shapes of an account identity in an API response. These are field
    # names from ordinary REST conventions, not anybody's personal data and not
    # any particular site -- no identity is compiled into this tool.
    IDENTITY_FIELD_HINTS = ("email", "username", "user_name", "login", "handle", "user_id")

    def _identity_evidence(self, payloads, is_challenge):
        """
        Returns (is_signed_in, user_identifier, source_url).

        Fail-closed. Positive evidence is a 2xx JSON body from the site that
        carries an account-identity field with a non-empty value -- that only
        happens when the server recognised the session. A challenge is negative
        evidence. Everything else is None (UNDETERMINED), never True.
        """
        for p in payloads:
            status = p.get("status")
            if status is None or not (200 <= status < 300):
                continue
            found = self._find_identity_field(p.get("data"))
            if found:
                return True, found, p.get("url")
        if is_challenge:
            # is_signed_in=False + challenge=True already carry the meaning;
            # this field holds a payload URL or nothing.
            return False, None, None
        return None, None, None

    @classmethod
    def _find_identity_field(cls, node, depth=0):
        """Walk a decoded JSON body for a populated identity-ish field."""
        if depth > 6:
            return None
        if isinstance(node, dict):
            for k, v in node.items():
                if isinstance(v, str) and v.strip() and len(v) < 200:
                    if any(h == k.lower() or k.lower().endswith("_" + h)
                           for h in cls.IDENTITY_FIELD_HINTS):
                        return v.strip()
                hit = cls._find_identity_field(v, depth + 1)
                if hit:
                    return hit
        elif isinstance(node, list):
            for item in node[:20]:
                hit = cls._find_identity_field(item, depth + 1)
                if hit:
                    return hit
        return None

    # WHICH BROWSER, by default.
    #
    # The first version of this kept a list of URL substrings that "need" a real
    # browser. That is the same hardcoding this tool exists to avoid: it routed
    # linkedin.com/feed to headless because the word "feed" was not on the list,
    # burned a walled attempt and a 60s barrier wait, then retried on the real
    # browser and walked straight in.
    #
    # So the default is inverted. The headed browser holds the real session, a
    # real fingerprint and no bot score -- it is the browser that works. The
    # headless daemon is the special case: it is a token optimisation for pages
    # that need no session at all, and it is opt-in per call.
    HEADLESS_SAFE = False   # set force_headed=False on a call for cheap public reads

    def smart_query(self, target_url, wait_seconds=3, keep_tab_open=False, settle_seconds=4.0,
                    force_headed=None):
        """
        Fetch a page on the cheapest browser that can actually load it, then
        verify the result against the wire.

        Headless first: it costs nothing and wins 99.4% of tokens on public
        pages. But measured on levels.fyi, the headless daemon carries the real
        session correctly and STILL gets served reCAPTCHA Enterprise -- session
        transfer and bot evasion are different problems, and only the first is
        solved. So when headless hits a challenge, this retries once on the
        headed browser, which has the real fingerprint the wall is checking.

        Returns (result, verdict). The verdict is verifier-mcp's, not a guess.
        """
        from .verify import verify

        # WHICH BROWSER. The headless daemon exists to save tokens on public
        # reads, and it is good at that. It is NOT good at anything defended:
        # measured on levels.fyi it carried the real session correctly and was
        # still served reCAPTCHA Enterprise, then succeeded on the headed
        # browser seconds later. All the cookie and localStorage syncing exists
        # to make headless impersonate a browser that is already running on
        # screen with the real session, real GPU and no bot score. So anything
        # that smells of a session or an application goes straight to the real
        # browser instead of burning a walled attempt first.
        # Default: the browser that is already signed in as him.
        use_headed = True if force_headed is None else force_headed

        if use_headed:
            res = self.query(target_url, wait_seconds=wait_seconds, keep_tab_open=keep_tab_open,
                             port_override=self.headed_port, settle_seconds=settle_seconds)
            wire = res.get("wire", {})
            verdict = verify(wire) if wire else {
                "resolution": "UNDETERMINED_NO_EVIDENCE", "verified": False}
            res["status"] = "SUCCESS" if verdict.get("verified") else "UNVERIFIED"
            res["verification"] = verdict
            if not verdict.get("verified"):
                res["warning"] = (
                    f"{verdict.get('resolution')}: content is UNTRUSTED -- "
                    "it may be a bot wall, a login page, or a rejected submission.")
            return res, verdict

        was_interactive = self.interactive
        self.interactive = False   # no blocking prompt on the throwaway first pass
        try:
            res = self.query(target_url, wait_seconds=wait_seconds,
                             keep_tab_open=keep_tab_open, settle_seconds=settle_seconds)
        finally:
            self.interactive = was_interactive

        wire = res.get("wire", {})
        if wire.get("challenge") and self.port != self.headed_port:
            # Headless was walled. The headed browser is the one with the real
            # GPU, fonts and window geometry the bot check is scoring.
            res = self.query(target_url, wait_seconds=wait_seconds, keep_tab_open=keep_tab_open,
                             port_override=self.headed_port, settle_seconds=settle_seconds)
            wire = res.get("wire", {})

        verdict = verify(wire) if wire else {
            "resolution": "UNDETERMINED_NO_EVIDENCE", "verified": False,
        }

        # A caller reading res["status"] must not be told SUCCESS about a page
        # the verdict rejected. "SUCCESS" here only ever meant "the fetch did
        # not throw" -- which is true of a bot wall and a login page too. Make
        # the status carry the verdict so the two can never disagree.
        res["status"] = "SUCCESS" if verdict.get("verified") else "UNVERIFIED"
        res["verification"] = verdict
        if not verdict.get("verified"):
            res["warning"] = (
                f"{verdict.get('resolution')}: content is UNTRUSTED -- "
                "it may be a bot wall, a login page, or a rejected submission."
            )
        return res, verdict

    def query(self, target_url, wait_seconds=3, capture_network_api=True, keep_tab_open=False,
              port_override=None, settle_seconds=2.5):
        t0 = time.time()

        # Politeness gate, before any browser work. A reader that gets itself
        # banned is worth less than no reader: the capability is pointless once
        # the source is gone.
        ok, wait, why = politeness.check(target_url)
        if not ok and wait > 0:
            self.logger.log_event("COOLDOWN_WAIT", target_url, {"seconds": wait, "reason": why})
            time.sleep(wait)
        elif not ok:
            self.logger.log_event("REFUSED_BLOCKED_HOST", target_url, {"reason": why})
            raise PermissionError(why)
        politeness.record_request(target_url)
        self.logger.log_request_start(target_url, {"wait": wait_seconds, "capture_api": capture_network_api})
        self._ensure_daemon()

        # 1. Create silent background target on the headless daemon (ZERO screen presence)
        # port_override drives the HEADED browser (:9225) through this same path.
        # Bot-sensitive and authenticated targets need the real window: headless
        # transfers the session fine but still trips reCAPTCHA Enterprise.
        saved_port = self.port
        if port_override:
            self.port = port_override
            self._browser_ws_url = None
        target_id, ws_url = self._create_silent_target("about:blank")
        captured_json_payloads = []
        # Wire-observed facts. None means "never observed" and is logged as null.
        doc_status = None
        doc_url = None
        sent_posts = []
        observed_responses = 0
        next_body_id = [9000]
        vendor_hits = []
        was_redirected = False
        console_problems = []
        redirect_chain = []
        timings = {}
        t_nav = time.time()

        try:
            ws = websocket.create_connection(ws_url, timeout=15)
            
            # Enable domains
            msg_id = 1
            ws.send(json.dumps({"id": msg_id, "method": "Page.enable"}))
            ws.recv()
            
            msg_id += 1
            ws.send(json.dumps({"id": msg_id, "method": "Runtime.enable"}))
            ws.recv()

            msg_id += 1
            ws.send(json.dumps({"id": msg_id, "method": "Network.enable"}))
            ws.recv()

            # Console + page errors: when a fill or click silently does nothing,
            # the reason is usually here and nowhere else.
            msg_id += 1
            ws.send(json.dumps({"id": msg_id, "method": "Log.enable"}))
            ws.recv()

            # Apply stealth scripts and real User-Agent BEFORE navigation
            self.daemon.apply_stealth_to_ws(ws)

            # Seed localStorage from the headed profile BEFORE navigating. Cookies
            # alone do not carry a Clerk/Auth0 session -- measured: 698 cookies
            # synced and the page still rendered logged out, because the session
            # lived in a 30KB localStorage object. This must run at document-start;
            # setting it after load is too late, the app has already decided.
            storage_synced = False
            try:
                parts = urllib.parse.urlsplit(target_url)
                origin = f"{parts.scheme}://{parts.netloc}"
                ok_store, store = self.daemon.read_headed_storage(origin)
                if ok_store and store:
                    msg_id += 1
                    ws.send(json.dumps({
                        "id": msg_id,
                        "method": "Page.addScriptToEvaluateOnNewDocument",
                        "params": {"source": self.daemon.storage_seed_script(origin, store)},
                    }))
                    ws.recv()
                    storage_synced = True
                    storage_note = f"{len(store)} keys from headed profile"
                else:
                    storage_note = store.get("error", "unavailable")
            except Exception as e:
                storage_note = f"storage sync failed: {e}"

            # Navigate to target_url with full stealth active
            msg_id += 1
            ws.send(json.dumps({
                "id": msg_id,
                "method": "Page.navigate",
                "params": {"url": target_url}
            }))
            ws.recv()

            timings["navigate"] = time.time() - t_nav
            # Wait for background page to render
            _t = time.time()
            time.sleep(wait_seconds)
            timings["render_wait"] = time.time() - _t

            # Intercept raw JSON API network responses.
            # WIRE TRUTH: doc_status/doc_url come from Network.responseReceived for the
            # main Document. They are the ONLY source for http_status. If the document
            # response is never observed, doc_status stays None and is logged as null.
            # Never synthesize a status code from page text. See sent_posts for the
            # request side (server echo of what was actually submitted).
            if capture_network_api:
                ws.settimeout(0.5)
                try:
                    while True:
                        raw = ws.recv()
                        evt = json.loads(raw)
                        method = evt.get("method", "")

                        if method in ("Log.entryAdded", "Runtime.exceptionThrown"):
                            try:
                                if method == "Log.entryAdded":
                                    e_ = evt["params"]["entry"]
                                    if e_.get("level") in ("error", "warning"):
                                        console_problems.append(
                                            f"{e_.get('level')}: {str(e_.get('text'))[:160]}")
                                else:
                                    d_ = evt["params"]["exceptionDetails"]
                                    console_problems.append(f"exception: {str(d_.get('text'))[:160]}")
                            except Exception:
                                pass

                        if method == "Network.responseReceived" and params_type_doc(evt):
                            redirect_chain.append(
                                f"{evt['params']['response'].get('status')} "
                                f"{evt['params']['response'].get('url','')[:90]}")

                        if method == "Network.requestWillBeSent":
                            params = evt.get("params", {})
                            req = params.get("request", {})
                            # Vendor bot-wall resource => challenge, on any site
                            if AuthDetector.is_vendor_challenge_url(req.get("url")):
                                vendor_hits.append(req.get("url"))
                            # A redirect on the main document we did not ask for
                            if params.get("type") == "Document" and params.get("redirectResponse"):
                                was_redirected = True
                            if req.get("method") in ("POST", "PUT", "PATCH"):
                                sent_posts.append({
                                    "request_id": params.get("requestId"),
                                    "method": req.get("method"),
                                    "url": req.get("url"),
                                    "post_data": req.get("postData"),
                                    "has_post_data": bool(req.get("hasPostData") or req.get("postData")),
                                })

                        if method == "Network.responseReceived":
                            params = evt.get("params", {})
                            resp = params.get("response", {})
                            mime = resp.get("mimeType", "")
                            req_id = params.get("requestId")
                            observed_responses += 1

                            # Main document response = the real HTTP status for
                            # this page. The target is created on about:blank, so
                            # its Document response can arrive first -- taking that
                            # would record a 200 for a blank page and make
                            # evidence_observed true with no page actually fetched.
                            if params.get("type") == "Document" and doc_status is None:
                                r_url = resp.get("url") or ""
                                if r_url and not r_url.startswith(("about:", "chrome://", "data:")):
                                    doc_status = _as_int(resp.get("status"))
                                    doc_url = r_url

                            # Attach the observed status to any POST we recorded
                            for p in sent_posts:
                                if p["request_id"] == req_id and "status" not in p:
                                    p["status"] = _as_int(resp.get("status"))
                                    p["response_url"] = resp.get("url")

                            if "json" in mime or "api" in resp.get("url", "").lower():
                                body_msg_id = next_body_id[0]
                                next_body_id[0] += 1
                                ws.send(json.dumps({
                                    "id": body_msg_id,
                                    "method": "Network.getResponseBody",
                                    "params": {"requestId": req_id}
                                }))
                                # Drain until we get OUR reply id; buffer any events we
                                # pass over so a stray event can't be read as the body.
                                body_res = None
                                for _ in range(200):
                                    try:
                                        cand = json.loads(ws.recv())
                                    except (websocket.WebSocketTimeoutException, TimeoutError):
                                        break
                                    if cand.get("id") == body_msg_id:
                                        body_res = cand
                                        break
                                body_text = (body_res or {}).get("result", {}).get("body", "")
                                if body_text:
                                    try:
                                        parsed = json.loads(body_text)
                                        captured_json_payloads.append({
                                            "url": resp.get("url"),
                                            "status": _as_int(resp.get("status")),
                                            "data": parsed
                                        })
                                    except Exception:
                                        pass
                except (websocket.WebSocketTimeoutException, TimeoutError):
                    pass
                ws.settimeout(15)

            # Get current URL and Title
            msg_id += 1
            ws.send(json.dumps({
                "id": msg_id,
                "method": "Runtime.evaluate",
                "params": {"expression": "window.location.href"}
            }))
            current_url = json.loads(ws.recv()).get("result", {}).get("result", {}).get("value", target_url)

            msg_id += 1
            ws.send(json.dumps({
                "id": msg_id,
                "method": "Runtime.evaluate",
                "params": {"expression": "document.title"}
            }))
            title = json.loads(ws.recv()).get("result", {}).get("result", {}).get("value", "")

            # Get full innerText
            msg_id += 1
            ws.send(json.dumps({
                "id": msg_id,
                "method": "Runtime.evaluate",
                "params": {"expression": "document.body ? document.body.innerText : ''"}
            }))
            raw_text = json.loads(ws.recv()).get("result", {}).get("result", {}).get("value", "")

            # Get raw HTML length for savings audit
            msg_id += 1
            ws.send(json.dumps({
                "id": msg_id,
                "method": "Runtime.evaluate",
                "params": {"expression": "document.documentElement ? document.documentElement.outerHTML.length : 0"}
            }))
            raw_dom_len = json.loads(ws.recv()).get("result", {}).get("result", {}).get("value", len(raw_text) * 4)

            # 2. Check for Auth Barrier / Challenge
            msg_id += 1
            ws.send(json.dumps({
                "id": msg_id,
                "method": "Runtime.evaluate",
                "params": {"expression": "!!document.querySelector('input[type=password]')"}
            }))
            has_pw = json.loads(ws.recv()).get("result", {}).get("result", {}).get("value", False)

            # DESTINATION MISMATCH: we asked for one page and the browser ended
            # up somewhere else. Catches client-side/SPA router bounces that never
            # emit an HTTP 3xx, which is how most modern auth walls actually work.
            # Site-agnostic: it only compares what we requested to where we landed.
            destination_mismatch = _norm(current_url) != _norm(target_url)

            is_challenge, challenge_reason = AuthDetector.check_is_challenge_wire(
                doc_status=doc_status,
                was_redirected=was_redirected or destination_mismatch,
                has_password_field=bool(has_pw),
                vendor_hits=vendor_hits,
            )

            # SETTLE PASS. Workday, iCIMS and similar ATS serve a clean 200 and
            # then raise the wall as a client-side state change one to two
            # seconds later: no redirect, no password field in the initial HTML,
            # no vendor script at first paint. A single fixed sleep before the
            # check misses all of it and reports the page as fine. So if nothing
            # fired on the first look, watch a little longer for late-arriving
            # challenge scripts and a late-rendered password field, and re-decide.
            if not is_challenge:
                settle_deadline = time.time() + settle_seconds
                ws.settimeout(0.4)
                try:
                    while time.time() < settle_deadline:
                        try:
                            evt = json.loads(ws.recv())
                        except (websocket.WebSocketTimeoutException, TimeoutError):
                            continue
                        if evt.get("method") in ("Network.requestWillBeSent", "Network.responseReceived"):
                            p_ = evt.get("params", {})
                            u_ = (p_.get("request", {}) or {}).get("url") or \
                                 (p_.get("response", {}) or {}).get("url")
                            if AuthDetector.is_vendor_challenge_url(u_):
                                vendor_hits.append(u_)
                                break
                except Exception:
                    pass
                ws.settimeout(15)

                msg_id += 1
                ws.send(json.dumps({
                    "id": msg_id,
                    "method": "Runtime.evaluate",
                    "params": {"expression": "!!document.querySelector('input[type=password]')"}
                }))
                try:
                    has_pw_late = json.loads(ws.recv()).get("result", {}).get("result", {}).get("value", False)
                except Exception:
                    has_pw_late = has_pw

                # Re-read the URL too: a client-side router bounce changes it
                # without ever emitting an HTTP redirect.
                msg_id += 1
                ws.send(json.dumps({
                    "id": msg_id, "method": "Runtime.evaluate",
                    "params": {"expression": "window.location.href"}
                }))
                try:
                    late_url = json.loads(ws.recv()).get("result", {}).get("result", {}).get("value", current_url)
                except Exception:
                    late_url = current_url
                if late_url and late_url != current_url:
                    current_url = late_url
                    destination_mismatch = _norm(current_url) != _norm(target_url)

                has_pw = bool(has_pw) or bool(has_pw_late)
                is_challenge, challenge_reason = AuthDetector.check_is_challenge_wire(
                    doc_status=doc_status,
                    was_redirected=was_redirected or destination_mismatch,
                    has_password_field=has_pw,
                    vendor_hits=vendor_hits,
                )
                if is_challenge:
                    challenge_reason = (challenge_reason or "") + " [appeared after settle]"
            if is_challenge:
                # Latch it. Previously the pipe logged the detection and then
                # issued another request to the same host seconds later -- the
                # detection worked, nothing acted on it. Now the host is refused
                # until a human clears it.
                politeness.record_block(target_url, challenge_reason)

                # Open challenge on headed browser (:9225) so Alex can see and solve it
                try:
                    open_url = f"http://127.0.0.1:{self.headed_port}/json/new?{current_url}"
                    req = urllib.request.Request(open_url, method="PUT")
                    with urllib.request.urlopen(req, timeout=5) as r:
                        h_tab = json.loads(r.read().decode())
                        h_tab_id = h_tab["id"]
                except Exception:
                    h_tab_id = None

                resolved = self.resolver.handle_auth_barrier(
                    tab_id=h_tab_id or target_id,
                    current_url=current_url,
                    reason=challenge_reason,
                    interactive=self.interactive
                )

                if resolved:
                    # Re-sync fresh cookies from headed browser back to headless daemon
                    self.daemon.sync_cookies_from_headed()
                    # Close headed helper tab
                    if h_tab_id:
                        try:
                            urllib.request.urlopen(f"http://127.0.0.1:{self.headed_port}/json/close/{h_tab_id}", timeout=3)
                        except Exception:
                            pass
                    # Reload page on headless daemon
                    time.sleep(1)
                    msg_id += 1
                    ws.send(json.dumps({"id": msg_id, "method": "Page.reload"}))
                    ws.recv()
                    time.sleep(wait_seconds)

                    msg_id += 1
                    ws.send(json.dumps({
                        "id": msg_id,
                        "method": "Runtime.evaluate",
                        "params": {"expression": "document.body ? document.body.innerText : ''"}
                    }))
                    raw_text = json.loads(ws.recv()).get("result", {}).get("result", {}).get("value", raw_text)

            # 3. Clean Extractor
            clean_lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
            clean_text = "\n".join(clean_lines)

            # Log comprehensive page state
            # is_wrong_page is decided by the OBSERVED status when we have one.
            # Title text is only a fallback hint, and is labelled as such.
            if doc_status is not None:
                is_wrong = doc_status >= 400
                wrong_reason = f"HTTP {doc_status} (observed)" if is_wrong else None
            else:
                is_wrong = None
                wrong_reason = "no Document response observed; status UNDETERMINED"

            # Identity evidence: only an authenticated payload naming the account counts.
            # Absence of a captcha is NOT evidence of being signed in.
            signed_in, identity, identity_src = self._identity_evidence(
                captured_json_payloads, is_challenge
            )

            self.logger.log_page_state(
                url=current_url,
                title=title,
                http_status=doc_status,          # None => null. Never synthesized.
                is_signed_in=signed_in,          # None => UNDETERMINED
                user_identifier=identity,        # None unless read off the wire
                auth_barrier=is_challenge,
                is_wrong_page=is_wrong,
                wrong_page_reason=wrong_reason,
                actions_taken=["navigate", "stealth_override", "dom_extract", "network_observe"]
            )
            self.logger.log_event("DECISION_TRACE", current_url, {
                # Why the challenge decision came out the way it did. Each signal
                # reports what it actually saw, so a wrong verdict can be traced
                # to the signal that misfired instead of being re-run blind.
                "signal_http_401_403": doc_status in (401, 403),
                "signal_challenge_vendor": vendor_hits[:3] or None,
                "signal_redirect_plus_password": {
                    "redirected": bool(was_redirected or destination_mismatch),
                    "password_field": bool(has_pw),
                    "fires": bool((was_redirected or destination_mismatch) and has_pw),
                },
                "decision": is_challenge,
                "decision_reason": challenge_reason,
                "redirect_chain": redirect_chain[:6],
                "console_problems": console_problems[:8],
                "timings_sec": {k: round(v, 2) for k, v in timings.items()},
                "browser_port": self.port,
                "browser_kind": "headed" if self.port == self.headed_port else "headless",
            })
            self.logger.log_event("WIRE_EVIDENCE", current_url, {
                # --- what we asked for vs what we got (native page issues) ---
                "requested_url": target_url,
                "landed_url": current_url,
                "destination_mismatch": destination_mismatch,
                "http_redirect_observed": was_redirected,
                "doc_status": doc_status,
                "doc_url": doc_url,
                # --- challenge evidence ---
                "challenge": is_challenge,
                "challenge_reason": challenge_reason,
                "challenge_vendors": vendor_hits,
                "password_field_present": bool(has_pw),
                # --- session / payload evidence ---
                "identity_source": identity_src,
                # Whether the session was seeded, never what was in it. These
                # are live credentials and they stay out of the log.
                "storage_synced": storage_synced,
                "storage_note": storage_note,
                "responses_observed": observed_responses,
                "json_payloads_captured": len(captured_json_payloads),
                "posts_sent": sent_posts,
                # --- overall ---
                "verdict": ("OBSERVED" if doc_status is not None
                            else "UNDETERMINED: no Document response seen"),
            })

            duration_ms = int((time.time() - t0) * 1000)
            clean_bytes = len(clean_text.encode("utf-8"))

            self.logger.log_data_extracted(
                url=current_url,
                raw_bytes=raw_dom_len,
                clean_bytes=clean_bytes,
                api_payloads_count=len(captured_json_payloads),
                duration_ms=duration_ms
            )

            result = {
                "status": "SUCCESS",
                # The wire facts, so callers verify against observation rather
                # than re-reading the page.
                "wire": {
                    "requested_url": target_url,
                    "landed_url": current_url,
                    "doc_status": doc_status,
                    "challenge": is_challenge,
                    "challenge_reason": challenge_reason,
                    "challenge_vendors": vendor_hits,
                    "posts_sent": sent_posts,
                    "storage_synced": storage_synced,
                    "driven_on_port": self.port,
                },
                "target_url": target_url,
                "final_url": current_url,
                "title": title,
                "auth_detected": is_challenge,
                "captured_api_payloads": captured_json_payloads,
                "clean_content": clean_text,
                "metrics": {
                    "raw_dom_bytes": raw_dom_len,
                    "clean_bytes": clean_bytes,
                    "savings_pct": f"{round((1.0 - (clean_bytes / max(1, raw_dom_len))) * 100, 2)}%",
                    "duration_ms": duration_ms
                }
            }

            ws.close()
            if not keep_tab_open:
                self._close_silent_target(target_id)
            self.port = saved_port
            self._browser_ws_url = None

            return result

        except Exception as e:
            self.logger.log_error(target_url, str(e))
            if not keep_tab_open:
                self._close_silent_target(target_id)
            self.port = saved_port
            self._browser_ws_url = None
            raise e
