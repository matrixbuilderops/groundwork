#!/usr/bin/env python3
"""
Master Package Telemetry & Download Engine
Calculates PyPI (pip) and NPM (npx) package metrics:
- First version & launch date
- Current version & latest update date
- Age in days
- Downloads per day, per month (30-day), and lifetime
- Averages for PyPI, NPM, and overall ecosystem
- Configurable via packages_config.json or CLI flags (--add-pip, --remove-pip, --add-npm, --remove-npm)
"""

import sys
import os
import json
import ssl
import time
import argparse
import urllib.request
import urllib.parse
from datetime import datetime

# Resolve real canonical directory even when executed via symlink
REAL_SCRIPT_PATH = os.path.realpath(__file__)
SCRIPT_DIR = os.path.dirname(REAL_SCRIPT_PATH)
CONFIG_PATH = os.path.join(SCRIPT_DIR, "packages_config.json")
OUTPUT_JSON = os.path.join(SCRIPT_DIR, "package_telemetry_latest.json")
HISTORY_JSONL = os.path.join(SCRIPT_DIR, "package_telemetry_history.jsonl")

# SSL Context (handles macOS certificate validation)
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

HEADERS = {
    "User-Agent": "PackageTelemetry/2.0 (+https://github.com/Alexander-Sorrell-IT)"
}


def load_config(custom_path=None):
    cfg_file = custom_path or CONFIG_PATH
    if os.path.exists(cfg_file):
        try:
            with open(cfg_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    default_config = {
        "pypi": [
            "cli-enforcement",
            "cli-wikia",
            "cli-collective",
            "cli-fleet"
        ],
        "npm": [
            "filelens-mcp",
            "sitemap-mcp",
            "starreckon",
            "starforge-cli"
        ]
    }
    save_config(default_config, cfg_file)
    return default_config


def save_config(cfg, custom_path=None):
    cfg_file = custom_path or CONFIG_PATH
    with open(cfg_file, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


def load_cached_telemetry():
    if os.path.exists(OUTPUT_JSON):
        try:
            with open(OUTPUT_JSON, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return None


def atomic_write_json(path, payload):
    """Write via temp file + os.replace so an interrupted run can never leave a
    truncated cache (a corrupt cache reads back as None and yields zeroed rows)."""
    tmp = f"{path}.tmp.{os.getpid()}"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass
        raise


def persist_blockers(data, config):
    """Reasons this run must not be written to the cache.

    The cache is what every later run falls back on, so a run that failed to
    fetch downloads must never overwrite it. Checked at package granularity,
    not just per group: two dead packages out of four still leave a non-zero
    group total, and would otherwise write zeros over good numbers.
    """
    blockers = []
    for group in ("pypi", "npm"):
        if config.get(group) and data["summary"][group]["total_lifetime"] == 0:
            blockers.append(f"no download data for any {group} package")
    # New package launches (<= 2 days live) legitimately have 0 stats until npm's nightly batch runs
    lost = [r["package"] for r in data.get("pypi", []) + data.get("npm", [])
            if r.get("downloads_error") and r.get("downloads_lifetime", 0) == 0 and r.get("days_live", 1) > 2]
    if lost:
        blockers.append("download fetch failed with no cached value: " + ", ".join(lost))
    return blockers


def doh_resolve(hostname):
    """Fallback DNS-over-HTTPS resolver via Cloudflare (1.1.1.1) and Google (8.8.8.8).
    Bypasses local router/ISP DNS failures like SERVFAIL or Errno 8."""
    for resolver_ip in ("1.1.1.1", "8.8.8.8"):
        try:
            doh_url = f"https://{resolver_ip}/dns-query?name={hostname}&type=A"
            req = urllib.request.Request(doh_url, headers={"Accept": "application/dns-json", "User-Agent": HEADERS["User-Agent"]})
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                answers = [a["data"] for a in data.get("Answer", []) if a.get("type") == 1]
                if answers:
                    return answers[0]
        except Exception:
            continue
    return None


def fetch_json(url, delay=0.15, max_retries=5):
    if delay > 0:
        time.sleep(delay)
    
    parsed = urllib.parse.urlparse(url)
    hostname = parsed.hostname
    
    last_err = None
    for attempt in range(max_retries):
        target_url = url
        headers = dict(HEADERS)
        
        # On retry attempts after DNS errors, resolve via DoH directly by raw IP
        if attempt > 0 and hostname and ("nodename nor servname" in str(last_err) or "Errno 8" in str(last_err) or "Name or service not known" in str(last_err)):
            resolved_ip = doh_resolve(hostname)
            if resolved_ip:
                headers["Host"] = hostname
                target_url = url.replace(f"://{hostname}", f"://{resolved_ip}")
        
        req = urllib.request.Request(target_url, headers=headers)
        try:
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=12) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}: {e.reason}"
            if e.code == 429:  # Rate limited -> exponential backoff
                time.sleep(1.5 * (attempt + 1))
            elif e.code >= 500:
                time.sleep(1.0 * (attempt + 1))
            else:
                break
        except Exception as e:
            last_err = str(e)
            time.sleep(0.5 * (attempt + 1))
            
    return {"_error": last_err or "Unknown error"}


def calculate_days_between(date_str1, date_str2=None):
    try:
        d1 = datetime.strptime(date_str1[:10], "%Y-%m-%d")
        if date_str2:
            d2 = datetime.strptime(date_str2[:10], "%Y-%m-%d")
        else:
            d2 = datetime.now()
        return max(1, (d2 - d1).days)
    except Exception:
        return 1


def get_pypi_stats(pkg_name, cached_pkg=None):
    # 1. Fetch release timeline from PyPI JSON API
    pypi_url = f"https://pypi.org/pypi/{pkg_name}/json"
    pypi_data = fetch_json(pypi_url, delay=0.1)

    first_ver = "N/A"
    first_date = "N/A"
    latest_ver = "N/A"
    latest_date = "N/A"
    total_releases = 0

    if "_error" not in pypi_data:
        releases = pypi_data.get("releases", {})
        version_dates = []
        for ver, files in releases.items():
            if files:
                t = files[0].get("upload_time_iso_8601") or files[0].get("upload_time")
                if t:
                    version_dates.append((t[:10], ver))
        version_dates.sort()
        if version_dates:
            first_date, first_ver = version_dates[0]
        latest_ver = pypi_data.get("info", {}).get("version", "N/A")
        latest_files = releases.get(latest_ver, [])
        if latest_files:
            latest_date = (latest_files[0].get("upload_time_iso_8601") or latest_files[0].get("upload_time") or "N/A")[:10]
        elif version_dates:
            latest_date, _ = version_dates[-1]
        total_releases = len(version_dates)
    elif cached_pkg:
        first_ver = cached_pkg.get("first_version", "N/A")
        first_date = cached_pkg.get("first_date", "N/A")
        latest_ver = cached_pkg.get("current_version", "N/A")
        latest_date = cached_pkg.get("current_date", "N/A")
        total_releases = cached_pkg.get("total_releases", 0)

    # 2. Fetch daily downloads from pypistats API
    stats_url = f"https://pypistats.org/api/packages/{pkg_name}/overall"
    stats_data = fetch_json(stats_url, delay=0.25)

    lifetime = 0
    per_month = 0
    per_day = 0
    days_active = calculate_days_between(first_date) if first_date != "N/A" else 1

    if "_error" not in stats_data:
        data_list = stats_data.get("data", [])
        with_mirrors = [d for d in data_list if d.get("category") == "with_mirrors"]
        if not with_mirrors:
            with_mirrors = data_list
        with_mirrors.sort(key=lambda x: x.get("date", ""))

        if with_mirrors:
            lifetime = sum(d.get("downloads", 0) for d in with_mirrors)
            last_30 = with_mirrors[-30:] if len(with_mirrors) >= 30 else with_mirrors
            per_month = sum(d.get("downloads", 0) for d in last_30)
            per_day = round(lifetime / days_active, 1) if days_active > 0 else 0
    
    # Fallback to cached downloads if live pypistats API failed or rate-limited
    dl_error = stats_data.get("_error")
    stale = False
    if lifetime == 0 and cached_pkg and cached_pkg.get("downloads_lifetime", 0) > 0:
        lifetime = cached_pkg.get("downloads_lifetime", 0)
        per_month = cached_pkg.get("downloads_per_month", 0)
        per_day = round(lifetime / days_active, 1) if days_active > 0 else cached_pkg.get("downloads_per_day", 0)
        stale = True

    return {
        "registry": "PyPI (pip)",
        "package": pkg_name,
        "first_version": f"v{first_ver}" if not str(first_ver).startswith("v") else first_ver,
        "first_date": first_date,
        "current_version": f"v{latest_ver}" if not str(latest_ver).startswith("v") else latest_ver,
        "current_date": latest_date,
        "days_live": days_active,
        "total_releases": total_releases,
        "downloads_per_day": per_day,
        "downloads_per_month": per_month,
        "downloads_lifetime": lifetime,
        "downloads_stale": stale,
        "downloads_error": dl_error,
        "url": f"https://pypi.org/project/{pkg_name}/"
    }


def get_npm_stats(pkg_name, cached_pkg=None):
    # 1. Fetch package info from NPM Registry API
    npm_url = f"https://registry.npmjs.org/{pkg_name}"
    npm_data = fetch_json(npm_url, delay=0.1)

    first_ver = "N/A"
    first_date = "N/A"
    latest_ver = "N/A"
    latest_date = "N/A"
    total_releases = 0

    if "_error" not in npm_data:
        time_map = npm_data.get("time", {})
        versions = [v for v in time_map.keys() if v not in ["created", "modified"]]
        if versions:
            first_ver = versions[0]
            first_date = time_map.get(first_ver, time_map.get("created", "N/A"))[:10]
        latest_ver = npm_data.get("dist-tags", {}).get("latest", "N/A")
        latest_date = time_map.get(latest_ver, time_map.get("modified", "N/A"))[:10]
        total_releases = len(versions)

    # 2. Fetch full download range
    today_str = datetime.now().strftime("%Y-%m-%d")
    dl_url = f"https://api.npmjs.org/downloads/range/2020-01-01:{today_str}/{pkg_name}"
    dl_data = fetch_json(dl_url, delay=0.1)

    lifetime = 0
    per_month = 0
    per_day = 0
    days_active = calculate_days_between(first_date) if first_date != "N/A" else 1

    if "_error" not in dl_data:
        downloads_list = dl_data.get("downloads", [])
        if downloads_list:
            lifetime = sum(d.get("downloads", 0) for d in downloads_list)
            last_30 = downloads_list[-30:] if len(downloads_list) >= 30 else downloads_list
            per_month = sum(d.get("downloads", 0) for d in last_30)
            per_day = round(lifetime / days_active, 1) if days_active > 0 else 0
    
    # Fallback to cached downloads if live NPM API failed or rate-limited
    dl_error = dl_data.get("_error")
    stale = False
    if lifetime == 0 and cached_pkg and cached_pkg.get("downloads_lifetime", 0) > 0:
        lifetime = cached_pkg.get("downloads_lifetime", 0)
        per_month = cached_pkg.get("downloads_per_month", 0)
        per_day = round(lifetime / days_active, 1) if days_active > 0 else cached_pkg.get("downloads_per_day", 0)
        stale = True

    return {
        "registry": "NPM (npx)",
        "package": pkg_name,
        "first_version": f"v{first_ver}" if not str(first_ver).startswith("v") else first_ver,
        "first_date": first_date,
        "current_version": f"v{latest_ver}" if not str(latest_ver).startswith("v") else latest_ver,
        "current_date": latest_date,
        "days_live": days_active,
        "total_releases": total_releases,
        "downloads_per_day": per_day,
        "downloads_per_month": per_month,
        "downloads_lifetime": lifetime,
        "downloads_stale": stale,
        "downloads_error": dl_error,
        "url": f"https://www.npmjs.com/package/{pkg_name}"
    }


def calc_group(items):
    n = len(items)
    if n == 0:
        return {"count": 0, "total_lifetime": 0, "total_month": 0, "total_day": 0, "avg_lifetime": 0, "avg_month": 0, "avg_day": 0, "avg_days_live": 0}
    tot_life = sum(i["downloads_lifetime"] for i in items)
    tot_month = sum(i["downloads_per_month"] for i in items)
    tot_day = sum(i["downloads_per_day"] for i in items)
    tot_days = sum(i["days_live"] for i in items)
    return {
        "count": n,
        "total_lifetime": tot_life,
        "total_month": tot_month,
        "total_day": round(tot_day, 1),
        "avg_lifetime": round(tot_life / n, 1),
        "avg_month": round(tot_month / n, 1),
        "avg_day": round(tot_day / n, 1),
        "avg_days_live": round(tot_days / n, 1)
    }


def compute_metrics(config):
    pypi_pkgs = config.get("pypi", [])
    npm_pkgs = config.get("npm", [])

    cached = load_cached_telemetry() or {}
    cached_pypi = {p.get("package"): p for p in cached.get("pypi", []) if isinstance(p, dict)}
    cached_npm = {p.get("package"): p for p in cached.get("npm", []) if isinstance(p, dict)}

    results_pypi = []
    results_npm = []

    for pkg in pypi_pkgs:
        results_pypi.append(get_pypi_stats(pkg, cached_pkg=cached_pypi.get(pkg)))

    for pkg in npm_pkgs:
        results_npm.append(get_npm_stats(pkg, cached_pkg=cached_npm.get(pkg)))

    summary_pypi = calc_group(results_pypi)
    summary_npm = calc_group(results_npm)
    summary_all = calc_group(results_pypi + results_npm)

    return {
        "timestamp": datetime.now().isoformat(),
        "pypi": results_pypi,
        "npm": results_npm,
        "summary": {
            "pypi": summary_pypi,
            "npm": summary_npm,
            "all": summary_all
        }
    }


def print_table(data):
    BOLD = "\033[1m"
    CYAN = "\033[36m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    MAGENTA = "\033[35m"
    BLUE = "\033[34m"
    RESET = "\033[0m"
    DIM = "\033[2m"

    print(f"\n{BOLD}{CYAN}==============================================================================================================={RESET}")
    print(f"                                   {BOLD}ALEXANDER SORRELL — PACKAGE METRICS & TELEMETRY{RESET}")
    print(f"{BOLD}{CYAN}==============================================================================================================={RESET}")

    headers = ["Type", "Package", "First Rel.", "First Date", "Current", "Updated", "Days Live", "DL / Day", "DL / Month", "Lifetime DL"]
    widths = [6, 17, 10, 11, 10, 11, 10, 10, 12, 13]

    def format_row(cols, colors=None, is_bold=False):
        res = []
        for i, col in enumerate(cols):
            val = str(col)
            w = widths[i]
            if i >= 6:
                formatted = val.rjust(w)
            else:
                formatted = val.ljust(w)
            c = colors[i] if colors and i < len(colors) else ""
            b = BOLD if is_bold else ""
            res.append(f"{b}{c}{formatted}{RESET}")
        return " │ ".join(res)

    sep_line = "─" * (sum(widths) + 3 * (len(widths) - 1))

    # Header Row
    print(f"{BOLD}{format_row(headers)}{RESET}")
    print(f"{DIM}{sep_line}{RESET}")

    # PyPI Rows
    for r in data["pypi"]:
        cols = [
            "pip",
            r["package"] + (" ~" if r.get("downloads_stale") else ""),
            r["first_version"],
            r["first_date"],
            r["current_version"],
            r["current_date"],
            f"{r['days_live']}d",
            f"{r['downloads_per_day']:,.1f}",
            f"{r['downloads_per_month']:,}",
            f"{r['downloads_lifetime']:,}"
        ]
        colors = [YELLOW, CYAN, DIM, DIM, GREEN, DIM, YELLOW, GREEN, GREEN, BOLD + GREEN]
        print(format_row(cols, colors))

    print(f"{DIM}{sep_line}{RESET}")

    # NPM Rows
    for r in data["npm"]:
        cols = [
            "npx",
            r["package"] + (" ~" if r.get("downloads_stale") else ""),
            r["first_version"],
            r["first_date"],
            r["current_version"],
            r["current_date"],
            f"{r['days_live']}d",
            f"{r['downloads_per_day']:,.1f}",
            f"{r['downloads_per_month']:,}",
            f"{r['downloads_lifetime']:,}"
        ]
        colors = [MAGENTA, CYAN, DIM, DIM, GREEN, DIM, YELLOW, GREEN, GREEN, BOLD + GREEN]
        print(format_row(cols, colors))

    print(f"{BOLD}{CYAN}==============================================================================================================={RESET}")
    print(f"{BOLD}                                              AVERAGES & SUMMARY{RESET}")
    print(f"{BOLD}{CYAN}==============================================================================================================={RESET}")

    p_sum = data["summary"]["pypi"]
    n_sum = data["summary"]["npm"]
    a_sum = data["summary"]["all"]

    sum_headers = ["Category", "Packages", "Avg Days Live", "Avg DL / Day", "Avg DL / Month", "Avg Lifetime / Pkg", "Total Lifetime DL"]
    sum_widths = [16, 10, 14, 14, 16, 20, 18]

    def format_sum_row(cols, colors=None, is_bold=False):
        res = []
        for i, col in enumerate(cols):
            val = str(col)
            w = sum_widths[i]
            if i >= 1:
                formatted = val.rjust(w)
            else:
                formatted = val.ljust(w)
            c = colors[i] if colors and i < len(colors) else ""
            b = BOLD if is_bold else ""
            res.append(f"{b}{c}{formatted}{RESET}")
        return " │ ".join(res)

    sum_sep = "─" * (sum(sum_widths) + 3 * (len(sum_widths) - 1))
    print(f"{BOLD}{format_sum_row(sum_headers)}{RESET}")
    print(f"{DIM}{sum_sep}{RESET}")

    # PyPI Summary
    print(format_sum_row([
        "PyPI (pip)",
        f"{p_sum['count']} pkgs",
        f"{p_sum['avg_days_live']}d",
        f"{p_sum['avg_day']:,.1f} / day",
        f"{p_sum['avg_month']:,.1f} / mo",
        f"{p_sum['avg_lifetime']:,.1f} / pkg",
        f"{p_sum['total_lifetime']:,}"
    ], [YELLOW, DIM, YELLOW, GREEN, GREEN, CYAN, BOLD + GREEN]))

    # NPM Summary
    print(format_sum_row([
        "NPM (npx)",
        f"{n_sum['count']} pkgs",
        f"{n_sum['avg_days_live']}d",
        f"{n_sum['avg_day']:,.1f} / day",
        f"{n_sum['avg_month']:,.1f} / mo",
        f"{n_sum['avg_lifetime']:,.1f} / pkg",
        f"{n_sum['total_lifetime']:,}"
    ], [MAGENTA, DIM, YELLOW, GREEN, GREEN, CYAN, BOLD + GREEN]))

    print(f"{DIM}{sum_sep}{RESET}")

    # ALL Summary
    print(format_sum_row([
        "ALL ECOSYSTEM",
        f"{a_sum['count']} pkgs",
        f"{a_sum['avg_days_live']}d",
        f"{a_sum['avg_day']:,.1f} / day",
        f"{a_sum['avg_month']:,.1f} / mo",
        f"{a_sum['avg_lifetime']:,.1f} / pkg",
        f"{a_sum['total_lifetime']:,}"
    ], [BOLD + CYAN, BOLD, BOLD + YELLOW, BOLD + GREEN, BOLD + GREEN, BOLD + CYAN, BOLD + GREEN], is_bold=True))

    print(f"{BOLD}{CYAN}==============================================================================================================={RESET}")

    stale = [r for r in data["pypi"] + data["npm"] if r.get("downloads_stale")]
    if stale:
        errs = sorted({r["downloads_error"] for r in stale if r.get("downloads_error")})
        names = ", ".join(r["package"] for r in stale)
        print(f"{YELLOW}  ~ Cached download numbers (live API unavailable): {names}{RESET}")
        if errs:
            print(f"{DIM}    Reason: {'; '.join(errs)}{RESET}")
        print(f"{DIM}    Release/version data above is live; only the download columns are cached.{RESET}")
    for reason in data.get("persist_blockers", []):
        print(f"{YELLOW}  ! {reason} — results not saved to cache.{RESET}")

    print(f"{DIM}Config: {CONFIG_PATH}  •  Output: {OUTPUT_JSON}{RESET}\n")


def main():
    parser = argparse.ArgumentParser(description="Master Package Telemetry & Download Calculator (PyPI & NPM)")
    parser.add_argument("--add-pip", "--add-pypi", dest="add_pip", type=str, help="Add a PyPI package to packages_config.json")
    parser.add_argument("--add-npm", "--add-npx", dest="add_npm", type=str, help="Add an NPM package to packages_config.json")
    parser.add_argument("--remove-pip", "--remove-pypi", dest="remove_pip", type=str, help="Remove a PyPI package from config")
    parser.add_argument("--remove-npm", "--remove-npx", dest="remove_npm", type=str, help="Remove an NPM package from config")
    parser.add_argument("--list", action="store_true", help="List monitored packages in packages_config.json")
    parser.add_argument("--json", dest="output_json_stdout", action="store_true", help="Output calculated metrics as JSON to stdout")
    parser.add_argument("--no-save", action="store_true", help="Do not save output JSON and history JSONL files")

    args = parser.parse_args()
    config = load_config()

    if args.add_pip:
        pkg = args.add_pip.strip()
        if pkg not in config["pypi"]:
            config["pypi"].append(pkg)
            save_config(config)
            print(f"Added PyPI package '{pkg}' to {CONFIG_PATH}.")
        else:
            print(f"PyPI package '{pkg}' is already configured.")
        return

    if args.add_npm:
        pkg = args.add_npm.strip()
        if pkg not in config["npm"]:
            config["npm"].append(pkg)
            save_config(config)
            print(f"Added NPM package '{pkg}' to {CONFIG_PATH}.")
        else:
            print(f"NPM package '{pkg}' is already configured.")
        return

    if args.remove_pip:
        pkg = args.remove_pip.strip()
        if pkg in config["pypi"]:
            config["pypi"].remove(pkg)
            save_config(config)
            print(f"Removed PyPI package '{pkg}' from {CONFIG_PATH}.")
        else:
            print(f"PyPI package '{pkg}' was not in config.")
        return

    if args.remove_npm:
        pkg = args.remove_npm.strip()
        if pkg in config["npm"]:
            config["npm"].remove(pkg)
            save_config(config)
            print(f"Removed NPM package '{pkg}' from {CONFIG_PATH}.")
        else:
            print(f"NPM package '{pkg}' was not in config.")
        return

    if args.list:
        print(f"\nMonitored Packages ({CONFIG_PATH}):")
        print(json.dumps(config, indent=2))
        return

    # Fetch & Calculate Telemetry
    data = compute_metrics(config)

    # Save to disk unless --no-save. The guard is per package, NOT ecosystem-wide:
    # a healthy NPM total must never license writing zeroed PyPI records over a
    # good cache, which is what poisons the fallback for every later run.
    data["persist_blockers"] = persist_blockers(data, config)
    if not args.no_save:
        if data["persist_blockers"]:
            for reason in data["persist_blockers"]:
                print(f"  ! Not saving: {reason}", file=sys.stderr)
            print("    Existing cache kept so the numbers survive the outage.", file=sys.stderr)
        else:
            atomic_write_json(OUTPUT_JSON, data)
            # history is a time series of OBSERVED numbers -- don't append a row
            # that is just cached values replayed during an outage.
            if not any(r.get("downloads_stale") for r in data["pypi"] + data["npm"]):
                with open(HISTORY_JSONL, "a", encoding="utf-8") as f:
                    f.write(json.dumps(data) + "\n")

    if args.output_json_stdout:
        print(json.dumps(data, indent=2))
    else:
        print_table(data)


if __name__ == "__main__":
    main()
