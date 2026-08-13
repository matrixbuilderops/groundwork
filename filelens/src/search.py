"""
Search — keyword search within a file, returns matching lines
with surrounding context. Designed for AI agents that need to
find a specific section without reading the whole file.
"""
from __future__ import annotations
import re
from pathlib import Path
from dataclasses import dataclass


@dataclass
class SearchMatch:
    """A single search result with surrounding context."""
    line_number: int
    line: str
    context_before: list[str]
    context_after: list[str]

    def render(self) -> str:
        """Return a human+AI readable block for this match."""
        parts = []
        for i, c in enumerate(self.context_before):
            lineno = self.line_number - len(self.context_before) + i
            parts.append(f"  {lineno:>5} │ {c}")
        parts.append(f"▶ {self.line_number:>5} │ {self.line}")
        for i, c in enumerate(self.context_after):
            lineno = self.line_number + 1 + i
            parts.append(f"  {lineno:>5} │ {c}")
        return "\n".join(parts)


def search_file(
    path: str,
    query: str,
    context_lines: int = 5,
    max_results: int = 20,
    use_regex: bool = False,
) -> list[SearchMatch]:
    """
    Search a file for `query` and return matches with context.

    Args:
        path:          Path to the file to search.
        query:         The string or regex pattern to search for.
        context_lines: Number of lines before/after each match to include.
        max_results:   Cap on number of matches returned (default 20).
        use_regex:     Treat `query` as a regular expression (default False).

    Returns:
        List of SearchMatch objects, each with line number, matched line,
        and surrounding context. Hand these to an AI — it can pinpoint
        exactly which chunk to read next.
    """
    lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    matches: list[SearchMatch] = []

    pattern = re.compile(query if use_regex else re.escape(query), re.IGNORECASE)

    for i, line in enumerate(lines):
        if pattern.search(line):
            before_start = max(0, i - context_lines)
            after_end = min(len(lines), i + context_lines + 1)

            matches.append(SearchMatch(
                line_number=i + 1,
                line=line,
                context_before=lines[before_start:i],
                context_after=lines[i + 1:after_end],
            ))

            if len(matches) >= max_results:
                break

    return matches
