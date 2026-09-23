"""
Discover the Chrome profiles running on this machine, so webpipe can be pointed
at any of them by name instead of by remembering port numbers.

Each profile is a separate Chrome launched with its own --user-data-dir, which
is what keeps their Google logins independent. The profile name here is just the
basename of that directory with the leading dot and `creds-` stripped, so
`~/.creds-kw1` is addressable as `kw1`.

Nothing is launched or changed here. This only reports what is already running.
"""

import re
import subprocess


def running():
    """
    Every Chrome with a debugging port open, newest listing wins.

    Returns a list of dicts: {name, port, data_dir, headless}.
    Renderer/helper processes are skipped -- they inherit the flags but are not
    the browser, and counting them would report the same profile many times.
    """
    try:
        out = subprocess.run(["ps", "-axo", "command="],
                             capture_output=True, text=True, timeout=8).stdout
    except Exception:
        return []

    found = {}
    for line in out.splitlines():
        if "--remote-debugging-port=" not in line or "--type=" in line:
            continue
        m_port = re.search(r"--remote-debugging-port=(\d+)", line)
        m_dir = re.search(r"--user-data-dir=(\S+)", line)
        if not (m_port and m_dir):
            continue
        port = int(m_port.group(1))
        data_dir = m_dir.group(1)
        base = data_dir.rstrip("/").split("/")[-1]
        name = re.sub(r"^\.?(creds-)?", "", base) or base
        found[port] = {
            "name": name,
            "port": port,
            "data_dir": data_dir,
            "headless": "--headless" in line,
        }
    return sorted(found.values(), key=lambda p: p["port"])


def resolve(token):
    """
    Turn 'kw1', '9223' or '.creds-kw1' into a port number.

    Raises ValueError with the available names rather than silently falling back
    to a default -- driving the wrong profile means acting as the wrong person.
    """
    profs = running()
    if not profs:
        raise ValueError("no Chrome with a debugging port is running")

    token = str(token).strip()
    if token.isdigit():
        port = int(token)
        if any(p["port"] == port for p in profs):
            return port
        raise ValueError(f"nothing running on port {port}. " + _avail(profs))

    t = token.lower().lstrip(".").replace("creds-", "")
    exact = [p for p in profs if p["name"].lower() == t]
    if exact:
        return exact[0]["port"]
    partial = [p for p in profs if t in p["name"].lower()]
    if len(partial) == 1:
        return partial[0]["port"]
    if len(partial) > 1:
        names = ", ".join(p["name"] for p in partial)
        raise ValueError(f"'{token}' matches several profiles: {names}")
    raise ValueError(f"no profile named '{token}'. " + _avail(profs))


def _avail(profs):
    return "available: " + ", ".join(f"{p['name']}(:{p['port']})" for p in profs)


def describe():
    """Human-readable table, including which account each one looks signed in as."""
    import json
    import urllib.request

    rows = []
    for p in running():
        who = "-"
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{p['port']}/json", timeout=4) as r:
                tabs = json.loads(r.read().decode())
            for t in tabs:
                u = t.get("url", "")
                if "mail.google" in u or "myaccount.google" in u:
                    who = (t.get("title") or "")[:46]
                    break
            else:
                who = f"{len([t for t in tabs if t.get('type') == 'page'])} tabs open"
        except Exception:
            who = "(unreachable)"
        rows.append((p["name"], p["port"], "headless" if p["headless"] else "headed", who))
    return rows
