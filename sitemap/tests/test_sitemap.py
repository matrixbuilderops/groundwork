"""
Tests for SiteMap.
"""
import asyncio
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from sitemap.src.parser import parse_forms, parse_actions, detect_auth
from sitemap.src.extractor import extract_title, extract_content, extract_api_hints
from sitemap.src.models import SiteAwarenessObject, Page, Form, Action, Auth

SAMPLE_HTML = """
<html>
<head><title>Test Site</title></head>
<body>
  <h1>Welcome</h1>
  <nav><a href="/about">About</a><a href="/pricing">Pricing</a></nav>
  <form action="/api/register" method="POST">
    <input name="email" type="email" />
    <input name="password" type="password" />
    <button type="submit">Sign Up</button>
  </form>
  <button>Buy Now</button>
  <input type="search" placeholder="Search" name="q" />
  <script>fetch("/api/products")</script>
</body>
</html>
"""

AUTH_HTML = """
<html><body><p>Please log in to continue.</p></body></html>
"""


def test_extract_title():
    assert extract_title(SAMPLE_HTML) == "Test Site"


def test_extract_title_fallback_h1():
    html = "<html><body><h1>My Page</h1></body></html>"
    assert extract_title(html) == "My Page"


def test_parse_forms():
    forms = parse_forms(SAMPLE_HTML, "/signup")
    assert len(forms) == 1
    assert "email" in forms[0].fields
    assert "password" in forms[0].fields
    assert forms[0].method == "POST"


def test_parse_actions_links():
    actions = parse_actions(SAMPLE_HTML, "https://example.com")
    labels = [a.label for a in actions]
    assert "About" in labels
    assert "Pricing" in labels


def test_parse_actions_button():
    actions = parse_actions(SAMPLE_HTML, "https://example.com")
    labels = [a.label for a in actions]
    assert "Buy Now" in labels


def test_parse_actions_search_input():
    actions = parse_actions(SAMPLE_HTML, "https://example.com")
    inputs = [a for a in actions if a.type == "input"]
    assert any(a.label == "Search" for a in inputs)


def test_detect_auth_true():
    assert detect_auth(AUTH_HTML) is True


def test_detect_auth_false():
    assert detect_auth(SAMPLE_HTML) is False


def test_extract_api_hints():
    hints = extract_api_hints(SAMPLE_HTML)
    assert "/api/products" in hints


def test_site_awareness_object_get_page():
    obj = SiteAwarenessObject(
        url="https://example.com",
        pages=[Page(path="/", title="Home", summary="Landing")],
    )
    assert obj.get_page("/") is not None
    assert obj.get_page("/missing") is None


def test_site_awareness_object_serialises():
    obj = SiteAwarenessObject(url="https://example.com")
    data = obj.model_dump()
    assert data["url"] == "https://example.com"
    assert isinstance(data["pages"], list)


# ─────────────────────────────────────────────────────────────────────────────
# Crawler: destination policy and the navigation budget.
# Both fail against the pre-fix crawler.py — the first because there was no
# policy at all, the second because max_pages bounded pages STORED, not
# navigations MADE (5,001 navigations at max_pages=10 was the measured case).
# ─────────────────────────────────────────────────────────────────────────────

def test_reserved_rule_names_the_range():
    from sitemap.src.crawler import reserved_rule
    assert "loopback" in reserved_rule("127.0.0.1")
    assert "loopback" in reserved_rule("::1")
    assert "loopback" in reserved_rule("::ffff:127.0.0.1")
    assert "link-local" in reserved_rule("169.254.169.254")   # cloud metadata
    assert "private" in reserved_rule("10.0.0.5")
    assert "private" in reserved_rule("172.16.0.1")
    assert "private" in reserved_rule("192.168.1.1")
    assert reserved_rule("93.184.216.34") is None             # example.com


def test_check_destination_blocks_loopback_and_non_http():
    from sitemap.src.crawler import check_destination
    with pytest.raises(PermissionError, match="loopback"):
        check_destination("http://127.0.0.1:8080/internal")
    with pytest.raises(PermissionError, match="loopback"):
        check_destination("http://localhost:8080/internal")
    with pytest.raises(PermissionError, match="link-local"):
        check_destination("http://169.254.169.254/latest/meta-data/")
    with pytest.raises(PermissionError, match="Blocked scheme"):
        check_destination("data:text/html,<b>x</b>")
    with pytest.raises(PermissionError, match="Blocked scheme"):
        check_destination("file:///etc/passwd")


def test_check_destination_honours_the_allowlist(monkeypatch):
    import importlib
    import sitemap.src.crawler as crawler
    monkeypatch.setenv("SITEMAP_ALLOW_PRIVATE", "127.0.0.1:8080")
    crawler = importlib.reload(crawler)
    crawler.check_destination("http://127.0.0.1:8080/ok")          # allowed
    with pytest.raises(PermissionError):
        crawler.check_destination("http://127.0.0.1:9999/nope")    # different port
    monkeypatch.delenv("SITEMAP_ALLOW_PRIVATE")
    importlib.reload(crawler)


class _FakePage:
    """A page whose every navigation 404s, counting navigations as it goes."""

    def __init__(self, links, counter):
        self._links = links
        self._counter = counter
        self.url = ""

    async def goto(self, url, **kw):
        self._counter.append(url)
        self.url = url
        if url.endswith("/"):
            return None
        raise RuntimeError("HTTP 404")

    async def content(self):
        return "<html><title>root</title><body>" + "".join(
            f'<a href="{h}">x</a>' for h in self._links) + "</body></html>"

    async def eval_on_selector_all(self, sel, js):
        return self._links


def test_max_pages_bounds_navigations_not_stored_pages(monkeypatch):
    """maxPages is a request budget. 500 dead links, budget 2 -> 2 navigations."""
    import sitemap.src.crawler as crawler

    navigations: list[str] = []
    links = [f"http://127.0.0.1:1234/dead/{i}" for i in range(500)]

    class _FakeBrowser:
        async def new_page(self):
            return _FakePage(links, navigations)

        async def close(self):
            pass

    class _FakeChromium:
        async def launch(self, **kw):
            return _FakeBrowser()

    class _FakePW:
        chromium = _FakeChromium()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(crawler, "async_playwright", lambda: _FakePW())
    monkeypatch.setattr(crawler, "check_destination", lambda url: None, raising=False)

    visited = asyncio.run(crawler.crawl("http://127.0.0.1:1234/", max_pages=2))
    assert list(visited) == ["/"]
    assert len(navigations) == 2, f"budget 2 but {len(navigations)} navigations made"


def test_repeated_dead_link_is_fetched_once(monkeypatch):
    """A dead link shared by every page must not be re-fetched per referrer."""
    import sitemap.src.crawler as crawler

    navigations: list[str] = []
    pages = {f"/p{i}": None for i in range(6)}
    links = [f"http://127.0.0.1:1234/p{i}" for i in range(6)] + ["http://127.0.0.1:1234/gone.html"]

    class _P(_FakePage):
        async def goto(self, url, **kw):
            navigations.append(url)
            self.url = url
            from urllib.parse import urlparse
            if urlparse(url).path not in pages:
                raise RuntimeError("HTTP 404")
            return None

    class _FakeBrowser:
        async def new_page(self):
            return _P(links, navigations)

        async def close(self):
            pass

    class _FakeChromium:
        async def launch(self, **kw):
            return _FakeBrowser()

    class _FakePW:
        chromium = _FakeChromium()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(crawler, "async_playwright", lambda: _FakePW())
    monkeypatch.setattr(crawler, "check_destination", lambda url: None, raising=False)

    visited = asyncio.run(crawler.crawl("http://127.0.0.1:1234/p0", max_pages=10))
    gone = [u for u in navigations if u.endswith("/gone.html")]
    assert len(visited) == 6
    assert len(gone) == 1, f"/gone.html fetched {len(gone)}x, expected 1"
    assert len(navigations) == 7, f"{len(navigations)} navigations for 6 pages + 1 dead link"
