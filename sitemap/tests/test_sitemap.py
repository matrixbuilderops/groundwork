"""
Tests for SiteMap.
"""
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
