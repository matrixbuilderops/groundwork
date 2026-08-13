"""
Crawler — discovers all routes on a site using Playwright.
Stays within the same origin. Returns a dict of path → raw HTML.
"""
from __future__ import annotations
from urllib.parse import urlparse, urljoin
from playwright.async_api import async_playwright, Page
import asyncio


async def _fetch_page(page: Page, url: str) -> str:
    """Navigate to a URL and return the full rendered HTML."""
    await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
    return await page.content()


async def crawl(start_url: str, max_pages: int = 50) -> dict[str, str]:
    """
    Crawl a website starting from `start_url`.

    Stays within the same origin (scheme + netloc).
    Returns a mapping of { path: raw_html } for every discovered page
    up to `max_pages`.

    Args:
        start_url:  The URL to start crawling from.
        max_pages:  Maximum number of pages to visit (default 50).

    Returns:
        Dict mapping URL path strings to their raw HTML content.
    """
    parsed = urlparse(start_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"

    visited: dict[str, str] = {}
    queue: list[str] = [start_url]

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        page = await browser.new_page()

        while queue and len(visited) < max_pages:
            url = queue.pop(0)
            path = urlparse(url).path or "/"

            if path in visited:
                continue

            try:
                html = await _fetch_page(page, url)
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
                        if link_path not in visited:
                            queue.append(urljoin(origin, link_path))

            except Exception:
                # Skip pages that time out or error
                continue

        await browser.close()

    return visited
