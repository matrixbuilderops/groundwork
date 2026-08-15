"""
Crawler — discovers all routes on a site using Playwright.
Stays within the same origin. Returns a dict of path → raw HTML.
"""
from __future__ import annotations
from urllib.parse import urlparse, urljoin
from playwright.async_api import async_playwright, Page
import asyncio
import ipaddress
import logging
import os
import socket

log = logging.getLogger(__name__)

# Kept in step with mcp/sitemap-mcp/src/index.ts (assertAllowedUrl).
# SITEMAP_ALLOW_PRIVATE="1" permits everything; otherwise it is a
# comma-separated allowlist of "host" / "host:port" entries. Default: empty.
_ALLOW_RAW = (os.environ.get("SITEMAP_ALLOW_PRIVATE") or "").strip()
_ALLOW_ALL = _ALLOW_RAW in ("1", "all", "ALL")
_ALLOW_HOSTS = set() if _ALLOW_ALL else {s.strip().lower() for s in _ALLOW_RAW.split(",") if s.strip()}


def reserved_rule(addr: str) -> str | None:
    """Which reserved range `addr` falls in, or None if it is public.

    Returns the rule name rather than a bool so a refusal can say why.
    """
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return None
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if ip.is_loopback:
        return "loopback (127.0.0.0/8, ::1)"
    if ip.is_link_local:
        return "link-local (169.254.0.0/16, fe80::/10) — cloud instance metadata"
    if ip.is_private:
        return "private (10/8, 172.16/12, 192.168/16, fc00::/7)"
    if ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return "multicast/reserved/unspecified"
    return None


def check_destination(url: str) -> None:
    """Raise PermissionError if `url` is not a permitted destination."""
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        raise PermissionError(
            f'Blocked scheme "{p.scheme}" for {url} — sitemap only fetches http:// and https://'
        )
    host = (p.hostname or "").lower()
    if _ALLOW_ALL or host in _ALLOW_HOSTS or (p.netloc or "").lower() in _ALLOW_HOSTS:
        return
    try:
        addrs = {ai[4][0] for ai in socket.getaddrinfo(host, p.port or (443 if p.scheme == "https" else 80))}
    except socket.gaierror as e:
        raise PermissionError(f'Cannot resolve host "{host}": {e}') from e
    for a in addrs:
        rule = reserved_rule(a)
        if rule:
            raise PermissionError(
                f'Blocked host "{p.netloc}" — resolves to {a}, in {rule}. '
                f"Set SITEMAP_ALLOW_PRIVATE={p.netloc} (or =1 for all) to permit it deliberately."
            )


async def _fetch_page(page: Page, url: str) -> tuple[str, str]:
    """Navigate to a URL and return (rendered HTML, the URL that served it)."""
    check_destination(url)
    await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
    # page.url is the URL after redirects — check it too, so a 302 cannot
    # walk the crawler into a private network past the pre-flight check.
    check_destination(page.url)
    return await page.content(), page.url


async def crawl(start_url: str, max_pages: int = 50) -> dict[str, str]:
    """
    Crawl a website starting from `start_url`.

    Stays within the same origin (scheme + netloc).
    Returns a mapping of { path: raw_html } for every discovered page
    up to `max_pages`.

    `max_pages` bounds NAVIGATIONS, not stored pages: a page linking to 5,000
    dead URLs used to cost 5,001 navigations at max_pages=10, because failures
    never entered `visited` and so never bounded the loop or the dedupe.
    Pages that fail are logged at WARNING with the reason — a page missing
    from the returned dict is never silently the same as a page with no links.

    Args:
        start_url:  The URL to start crawling from.
        max_pages:  Maximum number of navigations to make (default 50).

    Returns:
        Dict mapping URL path strings to their raw HTML content.
    """
    parsed = urlparse(start_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"

    visited: dict[str, str] = {}
    queue: list[str] = [start_url]
    seen: set[str] = {parsed.path or "/"}
    attempted = 0
    failed = 0

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        page = await browser.new_page()

        while queue and attempted < max_pages:
            url = queue.pop(0)
            attempted += 1

            try:
                html, final_url = await _fetch_page(page, url)
                final_parsed = urlparse(final_url)
                if f"{final_parsed.scheme}://{final_parsed.netloc}" != origin:
                    failed += 1
                    log.warning("crawl: %s redirected off-origin to %s — not mapped", url, final_url)
                    continue
                path = final_parsed.path or "/"
                if path in visited:
                    continue
                visited[path] = html

                # Discover new links on this page
                links = await page.eval_on_selector_all(
                    "a[href]",
                    "els => els.map(e => e.href)"
                )
                for link in links:
                    link_parsed = urlparse(link)
                    # Only follow same-origin links
                    if f"{link_parsed.scheme}://{link_parsed.netloc}" == origin:
                        link_path = link_parsed.path or "/"
                        if link_path not in seen:
                            seen.add(link_path)
                            queue.append(urljoin(origin, link_path))

            except Exception as e:
                failed += 1
                log.warning("crawl: skipping %s — %s: %s", url, type(e).__name__, e)
                continue

        await browser.close()

    log.info("crawl: %d navigation(s) of a %d budget, %d page(s) mapped, %d failed, "
             "%d link(s) still queued", attempted, max_pages, len(visited), failed, len(queue))
    return visited
