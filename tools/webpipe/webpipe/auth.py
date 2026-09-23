import subprocess
import time
import urllib.request
import json
import sys

class AuthDetector:
    """
    Auth/challenge detection from protocol facts, not from site-specific strings.

    The previous implementation matched substrings like 'login' in the URL and
    'sign in to upwork' in the page text. That needed a new rule per website,
    false-positived on any posting whose URL contained 'login' or any article
    that mentioned Cloudflare, and read the DOM -- the exact thing this pipe
    exists to avoid.

    These three signals are domain-general and come off the wire:

      1. HTTP 401/403 on the document. Standard HTTP auth semantics. Every site.
      2. The document redirected somewhere we did not ask for, AND the page it
         landed on has a password field. <input type=password> is an HTML
         standard, not a per-site selector.
      3. A subresource was fetched from a CAPTCHA/bot-wall VENDOR. This is a
         bounded list of ~5 vendors that covers essentially the whole web --
         not an unbounded list of websites. New site = no new rule.
    """

    # Vendors, not sites. Adding a website never requires touching this.
    CHALLENGE_VENDOR_HOSTS = (
        "challenges.cloudflare.com",
        "www.google.com/recaptcha",
        "www.recaptcha.net",
        "hcaptcha.com",
        "arkoselabs.com",
        "captcha-delivery.com",   # DataDome
        "perimeterx.net",
        "px-cloud.net",           # PerimeterX alternate CDN
        "funcaptcha.com",         # Arkose's earlier domain, still served
        "kasada.io",              # /.well-known/kasada/p.js -- real career portals
        "/.well-known/kasada/",   # Kasada when proxied behind the site's own origin
        "geetest.com",
        "datadome.co",
    )

    @classmethod
    def is_vendor_challenge_url(cls, url):
        u = (url or "").lower()
        return any(v in u for v in cls.CHALLENGE_VENDOR_HOSTS)

    @classmethod
    def check_is_challenge_wire(cls, doc_status=None, was_redirected=False,
                                has_password_field=False, vendor_hits=None):
        """
        Returns (is_challenge, reason). Evidence-based: with no positive signal
        it returns False rather than guessing, and callers must treat
        "not a challenge" as separate from "signed in".
        """
        vendor_hits = vendor_hits or []

        if doc_status in (401, 403):
            return True, f"HTTP {doc_status} on document (observed)"

        if vendor_hits:
            return True, f"challenge vendor resource loaded: {vendor_hits[0]}"

        if was_redirected and has_password_field:
            return True, "redirected to a page with a password field (observed)"

        return False, None


class AuthResolver:
    def __init__(self, port=9225, logger=None):
        self.port = port
        self.logger = logger

    def activate_tab(self, tab_id):
        try:
            url = f"http://127.0.0.1:{self.port}/json/activate/{tab_id}"
            urllib.request.urlopen(url, timeout=3)
            return True
        except Exception:
            return False

    # ── Window handoff ───────────────────────────────────────────────────────
    # Normally the browser is driven in the background and never steals focus.
    # A barrier is the one exception Alex asked for: push the window forward so
    # he can solve it, then put focus back where it was and resume in the
    # background. Focus is borrowed, not taken.

    @staticmethod
    def _osa(script):
        try:
            return subprocess.run(["osascript", "-e", script],
                                  capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:
            return ""

    def _frontmost_app(self):
        return self._osa(
            'tell application "System Events" to get name of first process whose frontmost is true'
        )

    def notify(self, title, message):
        """
        macOS notification, so a barrier is noticed even if the terminal is buried.

        The message is built from challenge_reason, which contains a URL taken
        off the page -- attacker-influenced text. Interpolating that into an
        AppleScript source string is a shell-injection vector: replacing only
        `"` leaves `&`, backslashes and newlines to break out of the literal and
        run `do shell script`. So nothing is interpolated: the text goes to
        osascript as an ARGUMENT, read back via `item N of argv`, where
        AppleScript treats it as data and never as code.
        """
        text = self._scrub(message)
        head = self._scrub(title)
        script = (
            'on run argv\n'
            '  display notification (item 1 of argv) '
            'with title (item 2 of argv) sound name "Submarine"\n'
            'end run'
        )
        try:
            subprocess.run(["osascript", "-e", script, text, head],
                           capture_output=True, text=True, timeout=5)
        except Exception:
            pass

    @staticmethod
    def _scrub(s):
        """Single line, bounded length, control characters removed."""
        s = "".join(ch for ch in str(s or "") if ch == " " or ch.isprintable())
        return s[:180]

    def _headed_chrome_pid(self):
        """
        PID of the Chrome that actually owns the visible window on self.port.

        Several Chrome instances run here on different debug ports, and some
        launched with --no-startup-window. `tell application "Google Chrome" to
        activate` picks one by name and silently does nothing when that one has
        no window -- it returns exit 0 while the screen never changes. Targeting
        the port's own process id raises the right window.
        """
        try:
            out = subprocess.run(
                ["ps", "-axo", "pid=,command="], capture_output=True, text=True, timeout=5
            ).stdout
        except Exception:
            return None
        for line in out.splitlines():
            if f"--remote-debugging-port={self.port}" in line and "--type=" not in line:
                try:
                    return int(line.strip().split()[0])
                except (ValueError, IndexError):
                    continue
        return None

    def bring_browser_forward(self):
        """Raise the headed browser so the wall is on screen and clickable."""
        pid = self._headed_chrome_pid()
        if pid:
            self._osa(
                f'tell application "System Events" to set frontmost of '
                f'(first process whose unix id is {pid}) to true'
            )
            return True
        # No headed browser found -- say so rather than pretend it was raised.
        self._osa('tell application "Google Chrome" to activate')
        return False

    def restore_focus(self, app_name):
        """Hand focus back to whatever he was using, and resume in the background."""
        if app_name and app_name.lower() != "google chrome":
            self._osa(f'tell application "{app_name}" to activate')
        else:
            self._osa('tell application "System Events" to set visible of process "Google Chrome" to false')

    def handle_auth_barrier(self, tab_id, current_url, reason, ws_driver=None, interactive=True):
        if self.logger:
            self.logger.log_auth_challenge(current_url, reason)

        # 1. Bring tab to front on user's screen
        self.activate_tab(tab_id)

        t_start = time.time()

        # Remember where focus was so it can be given back afterwards.
        previous_app = self._frontmost_app()
        self.bring_browser_forward()
        self.notify("webpipe needs you", f"{reason} — {current_url[:60]}")

        kind = "CAPTCHA / bot check" if "vendor" in (reason or "").lower() else "SIGN-IN"
        print("\n" + "="*80)
        print(f"⚠️  [WEBPIPE PAUSED — {kind} NEEDED]")
        print(f"Where:  {current_url}")
        print(f"Why:    {reason}")
        print("Chrome is now in front. Saved credentials should autofill — if they")
        print("do, this just needs the click. Solve it and I resume in the background.")
        print("="*80)

        if not interactive:
            print("[Non-interactive mode] Waiting up to 60 seconds for manual resolution in browser...")
            # Auto-poll until URL or text changes away from challenge
            for _ in range(60):
                time.sleep(1)
                if ws_driver:
                    # Cleared = the challenge page is gone AND no password field
                    # remains. Site-agnostic; no per-site strings.
                    new_url = ws_driver.get_url_sync()
                    has_pw = False
                    if hasattr(ws_driver, "has_password_field_sync"):
                        has_pw = ws_driver.has_password_field_sync()
                    is_still_blocked, _ = AuthDetector.check_is_challenge_wire(
                        doc_status=None,
                        was_redirected=(new_url != current_url),
                        has_password_field=has_pw,
                        vendor_hits=[],
                    )
                    if not is_still_blocked and new_url != current_url:
                        t_diff = round(time.time() - t_start, 1)
                        self.restore_focus(previous_app)
                        print(f"✅ Cleared in {t_diff}s. Focus returned — resuming in the background.")
                        if self.logger:
                            self.logger.log_auth_resolved(new_url, t_diff)
                        return True
            self.restore_focus(previous_app)
            print("❌ Auth barrier wait timed out. Focus returned.")
            return False

        # Interactive mode: prompt user to press enter once done
        try:
            input("\n👉 Once you have signed in / passed verification in Chrome, press [ENTER] here to resume: ")
        except (EOFError, KeyboardInterrupt):
            self.restore_focus(previous_app)
            print("\nWait cancelled. Focus returned.")
            return False

        t_diff = round(time.time() - t_start, 1)
        self.restore_focus(previous_app)
        print(f"✅ Resuming in the background after {t_diff}s. Focus returned.")
        if self.logger:
            self.logger.log_auth_resolved(current_url, t_diff)
        return True
