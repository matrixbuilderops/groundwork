"""
Content extractor — strips HTML noise and returns clean Markdown
per page. Uses trafilatura for main content extraction.
"""
from __future__ import annotations
import trafilatura
from bs4 import BeautifulSoup


def extract_title(html: str) -> str:
    """Pull the page title from HTML."""
    soup = BeautifulSoup(html, "html.parser")
    tag = soup.find("title")
    if tag:
        return tag.get_text(strip=True)
    h1 = soup.find("h1")
    if h1:
        return h1.get_text(strip=True)
    return "Untitled"


def extract_content(html: str) -> str:
    """
    Extract the main readable content from a page and return it
    as clean plain text (Markdown-friendly).

    Strips navbars, ads, footers, scripts — leaves only signal.
    """
    text = trafilatura.extract(
        html,
        include_comments=False,
        include_tables=True,
        no_fallback=False,
        output_format="markdown",
    )
    return text or ""


def extract_api_hints(html: str) -> list[str]:
    """
    Heuristically detect API endpoints referenced in the page —
    script tags, data attributes, fetch() calls, XHR references.
    """
    soup = BeautifulSoup(html, "html.parser")
    hints: set[str] = set()

    # Inline script content
    for script in soup.find_all("script"):
        src = script.string or ""
        for line in src.splitlines():
            line = line.strip()
            for kw in ("fetch(", "axios.", "xhr.open", '"/api/', "'/api/"):
                if kw in line:
                    # crude but effective: grab the quoted string after the keyword
                    for part in line.split('"'):
                        if part.startswith("/api/"):
                            hints.add(part.split("?")[0].split(" ")[0])
                    for part in line.split("'"):
                        if part.startswith("/api/"):
                            hints.add(part.split("?")[0].split(" ")[0])

    # data-* attributes that look like endpoints
    for tag in soup.find_all(True):
        for attr, val in tag.attrs.items():
            if isinstance(val, str) and val.startswith("/api/"):
                hints.add(val.split("?")[0])

    return sorted(hints)
