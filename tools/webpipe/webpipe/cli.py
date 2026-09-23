import argparse
import sys
import json
import os
from .pipe import WebPipe
from .logger import WebPipeLogger

def main():
    parser = argparse.ArgumentParser(
        description="WebPipe — Direct Web-to-Model Data Streaming Pipe with Saved Creds & Human-in-the-Loop Auth"
    )
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # get command
    p_get = subparsers.add_parser("get", help="Stream clean text from a URL via authenticated Chrome CDP")
    p_get.add_argument("url", help="Target URL to fetch")
    p_get.add_argument("--wait", type=int, default=3, help="Wait time in seconds for SPA rendering (default: 3)")
    p_get.add_argument("--port", type=int, default=9226, help="Headless Chrome CDP port (default: 9226)")
    p_get.add_argument("--profile", help="Which signed-in Chrome to drive: a name (kw1, sorrell) or a port. Default: sorrell/:9225. See `webpipe profiles`.")
    p_get.add_argument("--no-interactive", action="store_true", help="Disable manual interactive auth prompt")
    p_get.add_argument("--save", help="Save output to file")

    # json command
    p_json = subparsers.add_parser("json", help="Extract structured data and captured API payloads as JSON")
    p_json.add_argument("url", help="Target URL to query")
    p_json.add_argument("--wait", type=int, default=3, help="Wait time in seconds (default: 3)")
    p_json.add_argument("--port", type=int, default=9226, help="Headless Chrome CDP port (default: 9226)")
    p_json.add_argument("--profile", help="Which signed-in Chrome to drive: a name (kw1, sorrell) or a port. Default: sorrell/:9225. See `webpipe profiles`.")
    p_json.add_argument("--save", help="Save JSON to file")

    # logs command
    p_logs = subparsers.add_parser("logs", help="Display recent webpipe audit trail, rotate, or wipe")
    p_logs.add_argument("-n", type=int, default=15, help="Number of recent log events to show (default: 15)")
    p_logs.add_argument("--wipe", action="store_true", help="Wipe the current session log")
    p_logs.add_argument("--wipe-all", action="store_true", help="Purge all logs and backup archives")
    p_logs.add_argument("--rotate", action="store_true", help="Force an immediate log rotation")

    # check command
    p_check = subparsers.add_parser("check", help="Verify Chrome CDP connection and status")
    p_check.add_argument("--port", type=int, default=9226, help="Chrome CDP port (default: 9226)")

    subparsers.add_parser("profiles", help="List the signed-in Chrome profiles available to drive")

    p_blocks = subparsers.add_parser("blocks", help="Show hosts that blocked us, and never-automate hosts")
    p_unblock = subparsers.add_parser("unblock", help="Clear a block after YOU have checked the site is fine")
    p_unblock.add_argument("host")
    p_never = subparsers.add_parser("never", help="Mark a host as never-automate (target companies)")
    p_never.add_argument("host")
    p_never.add_argument("--remove", action="store_true")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    logger = WebPipeLogger()

    if args.command == "check":
        pipe = WebPipe(port=args.port, logger=logger)
        try:
            pipe._ensure_daemon()
            print(f"✅ Headless daemon running on port {args.port}!")
            ws_url = pipe._get_browser_ws_url()
            print(f"Debugger WS URL: {ws_url}")
        except Exception as e:
            print(f"❌ Connection failed: {e}")
            sys.exit(1)

    elif args.command == "logs":
        if args.wipe_all:
            logger.wipe_all_logs()
            print("🧹 Purged all WebPipe logs and backup files.")
            sys.exit(0)
        elif args.wipe:
            logger.wipe_session()
            print("🧹 Wiped current WebPipe session log.")
            sys.exit(0)
        elif args.rotate:
            logger.rotate_now()
            print("🔄 Rotated WebPipe log file.")
            sys.exit(0)

        log_path = logger.log_path
        if not os.path.exists(log_path) or os.path.getsize(log_path) == 0:
            print(f"No log entries found in {log_path}")
            sys.exit(0)

        with open(log_path, "r", encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip()]
        recent = lines[-args.n:]
        print(f"--- WebPipe Comprehensive Audit Log ({len(recent)} recent events) ---")
        for line in recent:
            try:
                data = json.loads(line)
                ts = data.get("timestamp", "")
                evt = data.get("event", "")
                url = data.get("url", "")[:50]
                det = data.get("details", {})
                print(f"[{ts}] {evt:<22} {url:<45} {det}")
            except Exception:
                print(line)

    elif args.command == "blocks":
        from . import politeness
        st = politeness.status()
        if st["blocked"]:
            print("BLOCKED US (automated requests refused):")
            for h, info in st["blocked"].items():
                print(f"  {h:28} {info['when']}  {info['why'][:60]}")
        else:
            print("BLOCKED US: none")
        print("\nNEVER AUTOMATE (open these in a normal browser):")
        for h in st["never"] or ["  none"]:
            print(f"  {h}")
        return

    elif args.command == "unblock":
        from . import politeness
        print(f"cleared {args.host}" if politeness.unblock(args.host)
              else f"{args.host} was not blocked")
        return

    elif args.command == "never":
        from . import politeness
        lst = politeness.never_automate(args.host, add=not args.remove)
        print(("removed " if args.remove else "added ") + args.host)
        print("never-automate list:", ", ".join(lst) or "empty")
        return

    elif args.command == "profiles":
        from .profiles import describe
        rows = describe()
        if not rows:
            print("No Chrome with a debugging port is running.")
            return
        print(f"{'PROFILE':14} {'PORT':6} {'MODE':9} SIGNED IN AS / STATE")
        print("-" * 78)
        for name, port, mode, who in rows:
            star = "  <- default" if port == 9225 else ""
            print(f"{name:14} :{port:<5} {mode:9} {who}{star}")
        print("\nUse:  webpipe get --profile <name> <url>")
        return

    elif args.command in ["get", "json"]:
        interactive = not getattr(args, "no_interactive", False)
        # --profile picks WHICH signed-in Chrome to drive. Wrong profile means
        # acting as the wrong person, so an unknown name is a hard error rather
        # than a silent fall back to the default.
        headed = 9225
        if getattr(args, "profile", None):
            from .profiles import resolve
            try:
                headed = resolve(args.profile)
            except ValueError as e:
                print(f"webpipe: {e}")
                return
        pipe = WebPipe(port=args.port, headed_port=headed,
                       logger=logger, interactive=interactive)
        if getattr(args, "profile", None):
            print(f"[profile {args.profile} -> headed :{headed}]")

        try:
            # smart_query, not query: the CLI must carry the same verdict the
            # MCP tools do. Reading a page without the verdict is the old
            # behaviour that reported bot walls and login pages as content.
            res, verdict = pipe.smart_query(args.url, wait_seconds=args.wait)
            res["verification"] = verdict

            if args.command == "json":
                out = json.dumps(res, indent=2)
                if args.save:
                    with open(args.save, "w", encoding="utf-8") as f:
                        f.write(out)
                    print(f"Saved JSON to {args.save}")
                else:
                    print(out)
            else:
                content = res["clean_content"]
                metrics = res["metrics"]
                if verdict.get("verified"):
                    tok = (verdict.get("truth_token") or {}).get("truthToken", "-")
                    notes = [pp["type"] for pp in verdict.get("paradoxes", [])]
                    banner = (f"{verdict.get('resolution')} status={res['wire'].get('doc_status')} "
                              f"token={tok}" + (f" | notes: {', '.join(notes)}" if notes else ""))
                else:
                    kinds = ", ".join(pp["type"] for pp in verdict.get("paradoxes", [])) \
                            or verdict.get("resolution", "UNDETERMINED")
                    reason = res["wire"].get("challenge_reason") or ""
                    banner = ("!! NOT VERIFIED -- " + kinds
                              + (f" | {reason[:70]}" if reason else "")
                              + "\n!! Treat this content as UNTRUSTED: it may be a bot wall "
                                "or a login page, not the page requested.")
                header = (
                    f"=== WEBPIPE STREAM: {res['title']} ===\n"
                    f"URL: {res['final_url']}\n"
                    f"{banner}\n"
                    f"Raw DOM: {metrics['raw_dom_bytes']:,} bytes | Clean: {metrics['clean_bytes']:,} bytes "
                    f"(Saved {metrics['savings_pct']} tokens/bandwidth in {metrics['duration_ms']}ms)\n"
                    f"{'='*60}\n"
                )
                full_output = header + content
                if args.save:
                    with open(args.save, "w", encoding="utf-8") as f:
                        f.write(full_output)
                    print(f"Saved stream output to {args.save}")
                else:
                    print(full_output)

        except Exception as e:
            print(f"❌ WebPipe execution error: {e}", file=sys.stderr)
            sys.exit(1)

if __name__ == "__main__":
    main()
