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
import textwrap
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


def load_descriptions(config=None, custom_dir=None):
    """Load package descriptions dynamically from config or descriptions file.
    Does NOT hardcode descriptions - purely data-driven from file."""
    base_dir = custom_dir or SCRIPT_DIR
    descriptions = {}

    # 1. Load from packages_config.json if "descriptions" key exists
    if isinstance(config, dict) and "descriptions" in config and isinstance(config["descriptions"], dict):
        descriptions.update(config["descriptions"])

    # 2. Load from package_descriptions.json if present
    desc_path = os.path.join(base_dir, "package_descriptions.json")
    if os.path.exists(desc_path):
        try:
            with open(desc_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    descriptions.update(data)
        except Exception:
            pass

    return descriptions


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
    api_desc = ""

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
        api_desc = pypi_data.get("info", {}).get("summary") or ""
    elif cached_pkg:
        first_ver = cached_pkg.get("first_version", "N/A")
        first_date = cached_pkg.get("first_date", "N/A")
        latest_ver = cached_pkg.get("current_version", "N/A")
        latest_date = cached_pkg.get("current_date", "N/A")
        total_releases = cached_pkg.get("total_releases", 0)
        api_desc = cached_pkg.get("description", "")

    # 2. Fetch lifetime & daily downloads from pypistats overall API
    stats_url = f"https://pypistats.org/api/packages/{pkg_name}/overall"
    stats_data = fetch_json(stats_url, delay=0.25)

    lifetime = 0
    per_month = 0
    last_day_dl = 0
    last_day_date = "N/A"
    today_dl = 0
    today_str = datetime.now().strftime("%Y-%m-%d")
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

            # Check if today's date exists in registry
            today_entries = [d for d in with_mirrors if d.get("date") == today_str]
            if today_entries:
                today_dl = today_entries[0].get("downloads", 0)

            # Last finalized completed day (strictly before today)
            past_entries = [d for d in with_mirrors if d.get("date", "") < today_str]
            if past_entries:
                last_day_entry = past_entries[-1]
                last_day_dl = last_day_entry.get("downloads", 0)
                last_day_date = last_day_entry.get("date", "N/A")
            elif with_mirrors:
                last_day_dl = with_mirrors[-1].get("downloads", 0)
                last_day_date = with_mirrors[-1].get("date", "N/A")

    # Fallback to cached downloads if live pypistats API failed or rate-limited
    dl_error = stats_data.get("_error")
    stale = False
    if lifetime == 0 and cached_pkg and cached_pkg.get("downloads_lifetime", 0) > 0:
        lifetime = cached_pkg.get("downloads_lifetime", 0)
        per_month = cached_pkg.get("downloads_per_month", 0)
        last_day_dl = cached_pkg.get("downloads_last_day", cached_pkg.get("downloads_per_day", 0))
        last_day_date = cached_pkg.get("downloads_last_day_date", "N/A")
        today_dl = cached_pkg.get("downloads_current_day", 0)
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
        "downloads_last_day": last_day_dl,
        "downloads_last_day_date": last_day_date,
        "downloads_current_day": today_dl,
        "downloads_current_day_date": today_str,
        "downloads_per_day": last_day_dl,
        "downloads_per_month": per_month,
        "downloads_lifetime": lifetime,
        "downloads_stale": stale,
        "downloads_error": dl_error,
        "description": api_desc,
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
    api_desc = ""

    if "_error" not in npm_data:
        time_map = npm_data.get("time", {})
        versions = [v for v in time_map.keys() if v not in ["created", "modified"]]
        if versions:
            first_ver = versions[0]
            first_date = time_map.get(first_ver, time_map.get("created", "N/A"))[:10]
        latest_ver = npm_data.get("dist-tags", {}).get("latest", "N/A")
        latest_date = time_map.get(latest_ver, time_map.get("modified", "N/A"))[:10]
        total_releases = len(versions)
        api_desc = npm_data.get("description") or ""
    elif cached_pkg:
        first_ver = cached_pkg.get("first_version", "N/A")
        first_date = cached_pkg.get("first_date", "N/A")
        latest_ver = cached_pkg.get("current_version", "N/A")
        latest_date = cached_pkg.get("current_date", "N/A")
        total_releases = cached_pkg.get("total_releases", 0)
        api_desc = cached_pkg.get("description", "")

    # 2. Fetch lifetime downloads from full range
    today_str = datetime.now().strftime("%Y-%m-%d")
    dl_url = f"https://api.npmjs.org/downloads/range/2020-01-01:{today_str}/{pkg_name}"
    dl_data = fetch_json(dl_url, delay=0.1)

    lifetime = 0
    per_month = 0
    last_day_dl = 0
    last_day_date = "N/A"
    today_dl = 0
    days_active = calculate_days_between(first_date) if first_date != "N/A" else 1

    if "_error" not in dl_data:
        downloads_list = dl_data.get("downloads", [])
        if downloads_list:
            # Filter to only days since the package actually existed
            if first_date != "N/A":
                downloads_list = [d for d in downloads_list if d.get("day", "") >= first_date]
            lifetime = sum(d.get("downloads", 0) for d in downloads_list)

            # Check if today's date exists in range
            today_entries = [d for d in downloads_list if d.get("day") == today_str]
            if today_entries:
                today_dl = today_entries[0].get("downloads", 0)

            # 30-day sum from range
            last_30 = downloads_list[-30:] if len(downloads_list) >= 30 else downloads_list
            per_month = sum(d.get("downloads", 0) for d in last_30)

    # 3. Fetch official last-day / last-month from npm point API
    dl_day_data = fetch_json(f"https://api.npmjs.org/downloads/point/last-day/{pkg_name}", delay=0.1)
    if "_error" not in dl_day_data:
        last_day_dl = dl_day_data.get("downloads", 0)
        last_day_date = dl_day_data.get("end", "N/A")

    dl_month_data = fetch_json(f"https://api.npmjs.org/downloads/point/last-month/{pkg_name}", delay=0.1)
    if "_error" not in dl_month_data and dl_month_data.get("downloads", 0) > 0:
        per_month = dl_month_data.get("downloads", 0)
    
    # Fallback to cached downloads if live NPM API failed or rate-limited
    dl_error = dl_data.get("_error")
    stale = False
    if lifetime == 0 and cached_pkg and cached_pkg.get("downloads_lifetime", 0) > 0:
        lifetime = cached_pkg.get("downloads_lifetime", 0)
        per_month = cached_pkg.get("downloads_per_month", 0)
        last_day_dl = cached_pkg.get("downloads_last_day", cached_pkg.get("downloads_per_day", 0))
        last_day_date = cached_pkg.get("downloads_last_day_date", "N/A")
        today_dl = cached_pkg.get("downloads_current_day", 0)
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
        "downloads_last_day": last_day_dl,
        "downloads_last_day_date": last_day_date,
        "downloads_current_day": today_dl,
        "downloads_current_day_date": today_str,
        "downloads_per_day": last_day_dl,
        "downloads_per_month": per_month,
        "downloads_lifetime": lifetime,
        "downloads_stale": stale,
        "downloads_error": dl_error,
        "description": api_desc,
        "url": f"https://www.npmjs.com/package/{pkg_name}"
    }


def calc_group(items):
    n = len(items)
    if n == 0:
        return {
            "count": 0,
            "total_lifetime": 0,
            "total_month": 0,
            "total_last_day": 0,
            "total_current_day": 0,
            "total_day": 0,
            "avg_lifetime": 0,
            "avg_month": 0,
            "avg_last_day": 0,
            "avg_current_day": 0,
            "avg_day": 0,
            "avg_days_live": 0
        }
    tot_life = sum(i["downloads_lifetime"] for i in items)
    tot_month = sum(i["downloads_per_month"] for i in items)
    tot_last = sum(i.get("downloads_last_day", i.get("downloads_per_day", 0)) for i in items)
    tot_cur = sum(i.get("downloads_current_day", 0) for i in items)
    tot_days = sum(i["days_live"] for i in items)
    return {
        "count": n,
        "total_lifetime": tot_life,
        "total_month": tot_month,
        "total_last_day": tot_last,
        "total_current_day": tot_cur,
        "total_day": round(tot_last, 1),
        "avg_lifetime": round(tot_life / n, 1),
        "avg_month": round(tot_month / n, 1),
        "avg_last_day": round(tot_last / n, 1),
        "avg_current_day": round(tot_cur / n, 1),
        "avg_day": round(tot_last / n, 1),
        "avg_days_live": round(tot_days / n, 1)
    }


def compute_metrics(config):
    pypi_pkgs = config.get("pypi", [])
    npm_pkgs = config.get("npm", [])

    descriptions = load_descriptions(config)

    cached = load_cached_telemetry() or {}
    cached_pypi = {p.get("package"): p for p in cached.get("pypi", []) if isinstance(p, dict)}
    cached_npm = {p.get("package"): p for p in cached.get("npm", []) if isinstance(p, dict)}

    results_pypi = []
    results_npm = []

    for pkg in pypi_pkgs:
        st = get_pypi_stats(pkg, cached_pkg=cached_pypi.get(pkg))
        if pkg in descriptions and descriptions[pkg]:
            st["description"] = descriptions[pkg]
        results_pypi.append(st)

    for pkg in npm_pkgs:
        st = get_npm_stats(pkg, cached_pkg=cached_npm.get(pkg))
        if pkg in descriptions and descriptions[pkg]:
            st["description"] = descriptions[pkg]
        results_npm.append(st)

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


def print_detailed_table(data):
    BOLD = "\033[1m"
    CYAN = "\033[36m"
    YELLOW = "\033[33m"
    MAGENTA = "\033[35m"
    RESET = "\033[0m"
    DIM = "\033[2m"

    banner_width = 148
    border = "=" * banner_width
    sep = "─" * banner_width

    title = "PROGRAM DIRECTORY & WHAT THEY DO"
    print(f"\n{BOLD}{CYAN}{border}{RESET}")
    print(f"{BOLD}{title.center(banner_width)}{RESET}")
    print(f"{BOLD}{CYAN}{border}{RESET}")

    all_rows = []
    for r in data.get("pypi", []):
        all_rows.append(("pip", r["package"], r.get("description") or "(No description provided in config file)"))
    for r in data.get("npm", []):
        all_rows.append(("npx", r["package"], r.get("description") or "(No description provided in config file)"))

    max_pkg_len = max([len(r[1]) for r in all_rows], default=19)
    pkg_width = max(19, max_pkg_len)
    desc_width = max(60, banner_width - 6 - 3 - pkg_width - 3)

    headers = ["Type", "Package", "What It Does / Architecture"]
    hdr_str = f"{headers[0]:<6} │ {headers[1]:<{pkg_width}} │ {headers[2]}"
    print(f"{BOLD}{hdr_str}{RESET}")
    print(f"{DIM}{sep}{RESET}")

    prev_type = None
    for r_type, pkg, desc in all_rows:
        if prev_type and prev_type != r_type:
            print(f"{DIM}{sep}{RESET}")
        prev_type = r_type

        t_color = YELLOW if r_type == "pip" else MAGENTA
        p_color = CYAN
        lines = textwrap.wrap(desc, width=desc_width) or [""]
        for i, line in enumerate(lines):
            if i == 0:
                t_col = f"{t_color}{r_type:<6}{RESET}"
                p_col = f"{p_color}{pkg:<{pkg_width}}{RESET}"
            else:
                t_col = " " * 6
                p_col = " " * pkg_width
            print(f"{t_col} │ {p_col} │ {line}")

    print(f"{BOLD}{CYAN}{border}{RESET}")


def print_table(data, detailed=False):
    BOLD = "\033[1m"
    CYAN = "\033[36m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    MAGENTA = "\033[35m"
    BLUE = "\033[34m"
    RESET = "\033[0m"
    DIM = "\033[2m"

    headers = ["Type", "Package", "First Rel.", "First Date", "Current", "Updated", "Days Live", "Last Day", "Today", "DL / Month", "Lifetime DL"]
    widths = [6, 17, 10, 11, 10, 11, 10, 10, 8, 12, 13]
    banner_width = sum(widths) + 3 * (len(widths) - 1)
    border_line = "=" * banner_width
    sep_line = "─" * banner_width

    title1 = "ALEXANDER SORRELL — PACKAGE METRICS & TELEMETRY"
    print(f"\n{BOLD}{CYAN}{border_line}{RESET}")
    print(f"{BOLD}{title1.center(banner_width)}{RESET}")
    print(f"{BOLD}{CYAN}{border_line}{RESET}")

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

    # Header Row
    print(f"{BOLD}{format_row(headers)}{RESET}")
    print(f"{DIM}{sep_line}{RESET}")

    # PyPI Rows
    for r in data["pypi"]:
        cur_day_val = r.get("downloads_current_day", 0)
        cols = [
            "pip",
            r["package"] + (" ~" if r.get("downloads_stale") else ""),
            r["first_version"],
            r["first_date"],
            r["current_version"],
            r["current_date"],
            f"{r['days_live']}d",
            f"{r.get('downloads_last_day', r.get('downloads_per_day', 0)):,}",
            f"{cur_day_val:,}",
            f"{r['downloads_per_month']:,}",
            f"{r['downloads_lifetime']:,}"
        ]
        cur_day_color = DIM if cur_day_val == 0 else GREEN
        colors = [YELLOW, CYAN, DIM, DIM, GREEN, DIM, YELLOW, GREEN, cur_day_color, GREEN, BOLD + GREEN]
        print(format_row(cols, colors))

    print(f"{DIM}{sep_line}{RESET}")

    # NPM Rows
    for r in data["npm"]:
        cur_day_val = r.get("downloads_current_day", 0)
        cols = [
            "npx",
            r["package"] + (" ~" if r.get("downloads_stale") else ""),
            r["first_version"],
            r["first_date"],
            r["current_version"],
            r["current_date"],
            f"{r['days_live']}d",
            f"{r.get('downloads_last_day', r.get('downloads_per_day', 0)):,}",
            f"{cur_day_val:,}",
            f"{r['downloads_per_month']:,}",
            f"{r['downloads_lifetime']:,}"
        ]
        cur_day_color = DIM if cur_day_val == 0 else GREEN
        colors = [MAGENTA, CYAN, DIM, DIM, GREEN, DIM, YELLOW, GREEN, cur_day_color, GREEN, BOLD + GREEN]
        print(format_row(cols, colors))

    print(f"{BOLD}{CYAN}{border_line}{RESET}")
    title2 = "AVERAGES & SUMMARY"
    print(f"{BOLD}{title2.center(banner_width)}{RESET}")
    print(f"{BOLD}{CYAN}{border_line}{RESET}")

    p_sum = data["summary"]["pypi"]
    n_sum = data["summary"]["npm"]
    a_sum = data["summary"]["all"]

    sum_headers = ["Category", "Packages", "Avg Days Live", "Avg Last Day", "Avg Today", "Avg DL / Month", "Avg Lifetime / Pkg", "Total Lifetime DL"]
    sum_widths = [16, 10, 14, 14, 12, 16, 20, 25]

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
        f"{p_sum.get('avg_last_day', p_sum.get('avg_day', 0)):,.1f} / day",
        f"{p_sum.get('avg_current_day', 0):,.1f} / day",
        f"{p_sum['avg_month']:,.1f} / mo",
        f"{p_sum['avg_lifetime']:,.1f} / pkg",
        f"{p_sum['total_lifetime']:,}"
    ], [YELLOW, DIM, YELLOW, GREEN, DIM if p_sum.get('avg_current_day', 0) == 0 else GREEN, GREEN, CYAN, BOLD + GREEN]))

    # NPM Summary
    print(format_sum_row([
        "NPM (npx)",
        f"{n_sum['count']} pkgs",
        f"{n_sum['avg_days_live']}d",
        f"{n_sum.get('avg_last_day', n_sum.get('avg_day', 0)):,.1f} / day",
        f"{n_sum.get('avg_current_day', 0):,.1f} / day",
        f"{n_sum['avg_month']:,.1f} / mo",
        f"{n_sum['avg_lifetime']:,.1f} / pkg",
        f"{n_sum['total_lifetime']:,}"
    ], [MAGENTA, DIM, YELLOW, GREEN, DIM if n_sum.get('avg_current_day', 0) == 0 else GREEN, GREEN, CYAN, BOLD + GREEN]))

    print(f"{DIM}{sum_sep}{RESET}")

    # ALL Summary
    print(format_sum_row([
        "ALL ECOSYSTEM",
        f"{a_sum['count']} pkgs",
        f"{a_sum['avg_days_live']}d",
        f"{a_sum.get('avg_last_day', a_sum.get('avg_day', 0)):,.1f} / day",
        f"{a_sum.get('avg_current_day', 0):,.1f} / day",
        f"{a_sum['avg_month']:,.1f} / mo",
        f"{a_sum['avg_lifetime']:,.1f} / pkg",
        f"{a_sum['total_lifetime']:,}"
    ], [BOLD + CYAN, BOLD, BOLD + YELLOW, BOLD + GREEN, BOLD + DIM if a_sum.get('avg_current_day', 0) == 0 else BOLD + GREEN, BOLD + GREEN, BOLD + CYAN, BOLD + GREEN], is_bold=True))

    print(f"{BOLD}{CYAN}{border_line}{RESET}")

    if detailed:
        print_detailed_table(data)

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

    mode_hint = "  •  Detailed mode: package-stats-detailed (or --detailed)" if not detailed else ""
    print(f"{DIM}Config: {CONFIG_PATH}  •  Output: {OUTPUT_JSON}{mode_hint}{RESET}\n")


def main():
    prog_name = os.path.basename(sys.argv[0])
    is_detailed_prog = prog_name in ("package-stats-detailed", "package_telemetry_detailed.py")

    # Support "package-stats detailed" subcommand syntax
    if len(sys.argv) > 1 and sys.argv[1] == "detailed":
        sys.argv.pop(1)
        is_detailed_prog = True

    parser = argparse.ArgumentParser(
        prog=prog_name,
        description="Master Package Telemetry & Download Calculator (PyPI & NPM)"
    )
    parser.add_argument("-d", "--detailed", action="store_true", help="Display second table listing all programs and what they do")
    parser.add_argument("--add-pip", "--add-pypi", dest="add_pip", type=str, help="Add a PyPI package to packages_config.json")
    parser.add_argument("--add-npm", "--add-npx", dest="add_npm", type=str, help="Add an NPM package to packages_config.json")
    parser.add_argument("--desc", type=str, help="Optional description when adding a package via --add-pip or --add-npm")
    parser.add_argument("--set-desc", nargs=2, metavar=("PACKAGE", "DESCRIPTION"), help="Set or update description for a package in packages_config.json")
    parser.add_argument("--remove-pip", "--remove-pypi", dest="remove_pip", type=str, help="Remove a PyPI package from config")
    parser.add_argument("--remove-npm", "--remove-npx", dest="remove_npm", type=str, help="Remove an NPM package from config")
    parser.add_argument("--list", action="store_true", help="List monitored packages in packages_config.json")
    parser.add_argument("--json", dest="output_json_stdout", action="store_true", help="Output calculated metrics as JSON to stdout")
    parser.add_argument("--no-save", action="store_true", help="Do not save output JSON and history JSONL files")

    args = parser.parse_args()
    config = load_config()

    is_detailed = is_detailed_prog or args.detailed

    if args.set_desc:
        pkg, desc = args.set_desc
        if "descriptions" not in config:
            config["descriptions"] = {}
        config["descriptions"][pkg] = desc
        save_config(config)
        print(f"Updated description for '{pkg}' in {CONFIG_PATH}.")
        return

    if args.add_pip:
        pkg = args.add_pip.strip()
        if pkg not in config["pypi"]:
            config["pypi"].append(pkg)
            if args.desc:
                if "descriptions" not in config:
                    config["descriptions"] = {}
                config["descriptions"][pkg] = args.desc
            save_config(config)
            print(f"Added PyPI package '{pkg}' to {CONFIG_PATH}.")
        else:
            print(f"PyPI package '{pkg}' is already configured.")
        return

    if args.add_npm:
        pkg = args.add_npm.strip()
        if pkg not in config["npm"]:
            config["npm"].append(pkg)
            if args.desc:
                if "descriptions" not in config:
                    config["descriptions"] = {}
                config["descriptions"][pkg] = args.desc
            save_config(config)
            print(f"Added NPM package '{pkg}' to {CONFIG_PATH}.")
        else:
            print(f"NPM package '{pkg}' is already configured.")
        return

    if args.remove_pip:
        pkg = args.remove_pip.strip()
        if pkg in config["pypi"]:
            config["pypi"].remove(pkg)
            if "descriptions" in config and pkg in config["descriptions"]:
                del config["descriptions"][pkg]
            save_config(config)
            print(f"Removed PyPI package '{pkg}' from {CONFIG_PATH}.")
        else:
            print(f"PyPI package '{pkg}' was not in config.")
        return

    if args.remove_npm:
        pkg = args.remove_npm.strip()
        if pkg in config["npm"]:
            config["npm"].remove(pkg)
            if "descriptions" in config and pkg in config["descriptions"]:
                del config["descriptions"][pkg]
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
        print_table(data, detailed=is_detailed)


if __name__ == "__main__":
    main()
