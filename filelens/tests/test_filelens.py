"""
Tests for FileLens.
"""
import tempfile
import textwrap
from pathlib import Path
from filelens.src.filelens import FileLens
from filelens.src.outline import build_outline
from filelens.src.search import search_file
from filelens.src.summarize import summarize_file


SAMPLE_PY = textwrap.dedent("""\
    import os
    import sys

    class UserAuth:
        def __init__(self, db):
            self.db = db

        def login(self, email, password):
            return self.db.check(email, password)

        def logout(self, user_id):
            self.db.invalidate(user_id)

    def main():
        auth = UserAuth(db=None)
        print(auth)
""")


def _make_file(content: str, suffix: str = ".py") -> str:
    f = tempfile.NamedTemporaryFile(mode="w", suffix=suffix, delete=False)
    f.write(content)
    f.close()
    return f.name


def test_outline_detects_class():
    path = _make_file(SAMPLE_PY)
    outline = build_outline(path)
    names = [n.name for n in outline.nodes]
    assert "UserAuth" in names


def test_outline_detects_methods():
    path = _make_file(SAMPLE_PY)
    outline = build_outline(path)
    user_auth = next(n for n in outline.nodes if n.name == "UserAuth")
    method_names = [c.name for c in user_auth.children]
    assert "login" in method_names
    assert "logout" in method_names


def test_outline_detects_top_level_function():
    path = _make_file(SAMPLE_PY)
    outline = build_outline(path)
    names = [n.name for n in outline.nodes]
    assert "main" in names


def test_outline_render_returns_string():
    path = _make_file(SAMPLE_PY)
    outline = build_outline(path)
    rendered = outline.render()
    assert isinstance(rendered, str)
    assert "UserAuth" in rendered


def test_outline_markdown():
    md = "# Heading 1\n\n## Heading 2\n\nSome text\n\n### Heading 3\n"
    path = _make_file(md, suffix=".md")
    outline = build_outline(path)
    assert outline.language == "Markdown"
    headings = [n.name for n in outline.nodes]
    assert "Heading 1" in headings
    assert "Heading 2" in headings


def test_search_finds_match():
    path = _make_file(SAMPLE_PY)
    results = search_file(path, "login")
    assert len(results) >= 1
    assert any("login" in r.line for r in results)


def test_search_includes_context():
    path = _make_file(SAMPLE_PY)
    results = search_file(path, "login", context_lines=2)
    assert results[0].context_before or results[0].context_after


def test_search_no_match():
    path = _make_file(SAMPLE_PY)
    results = search_file(path, "xyzzy_nonexistent")
    assert results == []


def test_search_regex():
    path = _make_file(SAMPLE_PY)
    results = search_file(path, r"def \w+", use_regex=True)
    assert len(results) >= 3  # __init__, login, logout, main


def test_chunk_returns_correct_lines():
    path = _make_file(SAMPLE_PY)
    lens = FileLens(path)
    result = lens.chunk(1, 2)
    assert "import os" in result
    assert "import sys" in result


def test_chunk_includes_line_numbers():
    path = _make_file(SAMPLE_PY)
    lens = FileLens(path)
    result = lens.chunk(1, 1)
    assert "1" in result


def test_summarize_contains_structure():
    path = _make_file(SAMPLE_PY)
    summary = summarize_file(path)
    assert "STRUCTURE" in summary
    assert "UserAuth" in summary


def test_summarize_contains_head():
    path = _make_file(SAMPLE_PY)
    summary = summarize_file(path)
    assert "HEAD" in summary
    assert "import os" in summary


def test_filelens_file_not_found():
    import pytest
    with pytest.raises(FileNotFoundError):
        FileLens("/nonexistent/path/file.py")


def test_filelens_all_modes():
    path = _make_file(SAMPLE_PY)
    lens = FileLens(path)
    assert lens.outline() is not None
    assert isinstance(lens.search("login"), list)
    assert isinstance(lens.chunk(1, 5), str)
    assert isinstance(lens.summarize(), str)
