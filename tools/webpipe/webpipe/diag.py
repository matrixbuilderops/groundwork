"""
Read the diagnostic trail back in a form you can act on.

    python3 -m webpipe.diag              last run
    python3 -m webpipe.diag -n 5         last 5 runs
    python3 -m webpipe.diag --failed     only runs that did not verify

A verdict alone is not debuggable: "PARADOX_BLOCKED" does not say which signal
decided that, nor whether the page even loaded. This prints the decision trace --
what each auth signal actually observed, the redirect chain, console errors, and
stage timings -- so a wrong answer can be traced to the signal that misfired
rather than re-run blind.
"""

import argparse
import json
import pathlib

LOG = pathlib.Path(__file__).resolve().parent.parent / "audit.jsonl"

G, R, Y, B, DIM, OFF = "\033[32m", "\033[31m", "\033[33m", "\033[36m", "\033[2m", "\033[0m"


def runs(path=LOG):
    """Group the flat event log into runs, newest last."""
    out, current = [], None
    for line in path.read_text(errors="ignore").splitlines():
        try:
            row = json.loads(line)
        except Exception:
            continue
        ev = row.get("event")
        if ev == "REQUEST_START":
            if current:
                out.append(current)
            current = {"url": row.get("url"), "start": row.get("timestamp")}
        if current is None:
            continue
        if ev in ("DECISION_TRACE", "WIRE_EVIDENCE", "PAGE_STATE", "DATA_EXTRACTED", "ERROR"):
            current[ev] = row.get("details", {})
            current.setdefault("landed", row.get("url"))
    if current:
        out.append(current)
    return out


def show(run):
    wire = run.get("WIRE_EVIDENCE", {})
    trace = run.get("DECISION_TRACE", {})
    data = run.get("DATA_EXTRACTED", {})

    verdict = wire.get("verdict", "?")
    challenged = wire.get("challenge")
    tone = R if challenged else (G if str(verdict).startswith("OBSERVED") else Y)

    print(f"\n{B}{'=' * 78}{OFF}")
    print(f"{B}{run.get('url', '?')[:76]}{OFF}")
    print(f"{DIM}{run.get('start', '')}{OFF}")
    print(f"{'=' * 78}")

    kind = trace.get("browser_kind", "?")
    port = trace.get("browser_port", "?")
    print(f"  browser      : {kind} :{port}")
    print(f"  landed       : {wire.get('landed_url', run.get('landed', '?'))[:64]}")
    print(f"  http status  : {wire.get('doc_status')}   "
          f"{DIM}(None = no Document response observed){OFF}"
          if wire.get("doc_status") is None else
          f"  http status  : {wire.get('doc_status')}")
    print(f"  challenge    : {tone}{challenged}{OFF}"
          + (f"  -- {wire.get('challenge_reason', '')[:56]}" if wire.get("challenge_reason") else ""))

    if trace:
        print(f"\n  {B}why it decided that{OFF}")
        fired = "FIRED" if trace.get("signal_http_401_403") else "no"
        print(f"    401/403 on document       : {fired}")
        v = trace.get("signal_challenge_vendor")
        print(f"    challenge vendor resource : {('FIRED -> ' + v[0][:44]) if v else 'no'}")
        rp = trace.get("signal_redirect_plus_password", {})
        print(f"    redirect + password field : "
              f"{'FIRED' if rp.get('fires') else 'no'}"
              f"{DIM} (redirected={rp.get('redirected')}, password={rp.get('password_field')}){OFF}")

    chain = trace.get("redirect_chain") or []
    if chain:
        print(f"\n  {B}document chain{OFF}")
        for hop in chain:
            print(f"    {hop[:70]}")

    posts = wire.get("posts_sent") or []
    if posts:
        print(f"\n  {B}submissions observed{OFF}")
        for p in posts[:6]:
            st = p.get("status")
            mark = R + "REJECTED" + OFF if isinstance(st, int) and st >= 400 else f"{st}"
            body = "body readable" if p.get("post_data") else R + "BODY UNREADABLE" + OFF
            print(f"    {p.get('method')} {str(p.get('url'))[:44]}  -> {mark}  {body}")

    probs = trace.get("console_problems") or []
    if probs:
        print(f"\n  {B}console{OFF}")
        for p in probs[:6]:
            print(f"    {R}{p[:72]}{OFF}")

    t = trace.get("timings_sec") or {}
    if t or data:
        bits = [f"{k}={v}s" for k, v in t.items()]
        if data.get("duration_ms"):
            bits.append(f"total={round(data['duration_ms'] / 1000, 1)}s")
        if data.get("savings_pct"):
            bits.append(f"tokens_saved={data['savings_pct']}")
        print(f"\n  {DIM}{'  '.join(bits)}{OFF}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", type=int, default=1, help="how many recent runs")
    ap.add_argument("--failed", action="store_true", help="only runs with a challenge or no status")
    args = ap.parse_args()

    if not LOG.is_file():
        print(f"no log at {LOG}")
        return
    all_runs = runs()
    if args.failed:
        all_runs = [r for r in all_runs
                    if r.get("WIRE_EVIDENCE", {}).get("challenge")
                    or r.get("WIRE_EVIDENCE", {}).get("doc_status") is None]
    for r in all_runs[-args.n:]:
        show(r)
    print()


if __name__ == "__main__":
    main()
