"""
Do not get banned from the sites you need to read.

A reader that gets itself blocked is worth less than no reader at all -- the
capability is pointless once the source is gone. This module enforces two things
the pipe was missing:

1. A per-domain cooldown, so the same host is never hammered in quick
   succession. Two loads of product.ai/about/ seventeen seconds apart from an
   automation-flagged browser is what earned a deliberate WAF ban.

2. A hard stop once a block or challenge is observed. Previously the pipe logged
   AUTH_CHALLENGE_DETECTED and then issued another request to the same host
   nineteen seconds later. The detection worked; nothing acted on it.

State is persisted, so a block survives restarts. Clearing one is deliberate and
manual -- an automatic retry is how a soft block becomes a permanent one.
"""

import json
import os
import pathlib
import time
from urllib.parse import urlsplit

STATE = pathlib.Path(__file__).resolve().parent.parent / "politeness.json"

# Minimum seconds between requests to the same host. Generous on purpose: the
# cost of waiting is seconds, the cost of a ban is the source.
DEFAULT_COOLDOWN = 45.0

# Hosts that must never receive automated traffic. A company deciding whether to
# hire you should only ever see a human using a normal browser.
NEVER_AUTOMATE = set()


def _host(url):
    try:
        h = urlsplit(url or "").netloc.lower()
        return h[4:] if h.startswith("www.") else h
    except Exception:
        return ""


def _load():
    try:
        return json.loads(STATE.read_text())
    except Exception:
        return {"last_seen": {}, "blocked": {}, "never": []}


def _save(d):
    try:
        STATE.write_text(json.dumps(d, indent=2))
        STATE.chmod(0o600)
    except Exception:
        pass


def check(url, cooldown=DEFAULT_COOLDOWN):
    """
    Returns (ok, wait_seconds, reason).

    ok=False with wait_seconds>0 means wait. ok=False with wait_seconds=0 means
    refuse outright -- the host is blocked or on the never-automate list, and
    only a human decision should change that.
    """
    host = _host(url)
    if not host:
        return True, 0, None

    d = _load()

    if host in set(d.get("never", [])) | NEVER_AUTOMATE:
        return False, 0, (
            f"{host} is on the never-automate list. Open it in a normal browser "
            "window instead. Automated traffic to a company you are engaged with "
            "is not worth anything it could return."
        )

    blocked = (d.get("blocked") or {}).get(host)
    if blocked:
        return False, 0, (
            f"{host} BLOCKED us at {blocked.get('when')} ({blocked.get('why')}). "
            "Refusing further automated requests. Use a normal browser, or clear "
            f"it deliberately: webpipe unblock {host}"
        )

    last = (d.get("last_seen") or {}).get(host)
    if last:
        elapsed = time.time() - last
        if elapsed < cooldown:
            return False, round(cooldown - elapsed, 1), (
                f"{host} was requested {elapsed:.0f}s ago; cooldown is {cooldown:.0f}s"
            )
    return True, 0, None


def record_request(url):
    host = _host(url)
    if not host:
        return
    d = _load()
    d.setdefault("last_seen", {})[host] = time.time()
    _save(d)


def record_block(url, why):
    """Latch a block. Nothing clears this automatically, by design."""
    host = _host(url)
    if not host:
        return
    d = _load()
    d.setdefault("blocked", {})[host] = {
        "when": time.strftime("%Y-%m-%d %H:%M:%S"),
        "why": str(why)[:200],
    }
    _save(d)
    return host


def unblock(host):
    d = _load()
    host = host.lower().lstrip(".")
    if host.startswith("www."):
        host = host[4:]
    removed = (d.get("blocked") or {}).pop(host, None)
    _save(d)
    return bool(removed)


def never_automate(host, add=True):
    d = _load()
    lst = set(d.get("never", []))
    host = _host(f"https://{host}") or host.lower()
    lst.add(host) if add else lst.discard(host)
    d["never"] = sorted(lst)
    _save(d)
    return sorted(lst)


def status():
    d = _load()
    return {
        "blocked": d.get("blocked", {}),
        "never": d.get("never", []),
        "recent": {h: round(time.time() - t) for h, t in (d.get("last_seen") or {}).items()},
    }
