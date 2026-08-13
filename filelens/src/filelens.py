"""
FileLens — the main entry point for AI agents.

Usage:
    from filelens.src import FileLens

    lens = FileLens("path/to/file.py")

    # Step 1 — always start here
    print(lens.outline())

    # Step 2 — find what you need
    results = lens.search("def login")

    # Step 3 — read only what matters
    print(lens.chunk(34, 89))

    # Or — get a full summary in one shot
    print(lens.summarize())
"""
from __future__ import annotations
from pathlib import Path
from .outline import build_outline, FileOutline
from .search import search_file, SearchMatch
from .summarize import summarize_file


class FileLens:
    """
    Intelligent file reader for AI agents.

    Instead of dumping an entire file into an AI's context window,
    FileLens gives the AI four targeted modes:

    - outline()   → What is the structure of this file?
                    Returns classes, functions, sections with line numbers.
                    Always call this first — it costs almost nothing and
                    tells the AI exactly where everything lives.

    - search()    → Where is X in this file?
                    Keyword or regex search with surrounding context lines.
                    Use this when you know what you're looking for.

    - chunk()     → Give me lines N to M.
                    Precise line-range extraction. Use after outline() or
                    search() tells you exactly which lines to read.

    - summarize() → What does this file do?
                    Structure + head + tail composed into one readable block.
                    Use this when you've never seen the file before.

    Design principle:
        outline → search/summarize → chunk
        Never read a file from top to bottom. Always build the map first.
    """

    def __init__(self, path: str) -> None:
        self.path = Path(path)
        if not self.path.exists():
            raise FileNotFoundError(f"FileLens: file not found: {path}")

    # ------------------------------------------------------------------ #
    # Mode 1 — Outline                                                     #
    # ------------------------------------------------------------------ #

    def outline(self) -> FileOutline:
        """
        Scan the file structure and return an outline.

        Returns a FileOutline with all classes, functions, headings,
        and their line numbers. Call .render() on the result for a
        tree-style string ready to paste into an AI prompt.

        Returns:
            FileOutline — structure of the file with line numbers.
        """
        return build_outline(str(self.path))

    # ------------------------------------------------------------------ #
    # Mode 2 — Search                                                      #
    # ------------------------------------------------------------------ #

    def search(
        self,
        query: str,
        context_lines: int = 5,
        max_results: int = 20,
        use_regex: bool = False,
    ) -> list[SearchMatch]:
        """
        Search the file for `query` and return matches with context.

        Args:
            query:         Text or regex to search for.
            context_lines: Lines of context to include around each match.
            max_results:   Maximum number of matches to return.
            use_regex:     Treat query as a regex pattern.

        Returns:
            List of SearchMatch objects. Call .render() on each for
            a formatted block with line numbers and context.
        """
        return search_file(
            str(self.path),
            query,
            context_lines=context_lines,
            max_results=max_results,
            use_regex=use_regex,
        )

    # ------------------------------------------------------------------ #
    # Mode 3 — Chunk                                                       #
    # ------------------------------------------------------------------ #

    def chunk(self, start: int, end: int) -> str:
        """
        Read a specific line range from the file.

        Use after outline() or search() to read only the section
        you actually need. Lines are 1-indexed and inclusive.

        Args:
            start: First line to read (1-indexed).
            end:   Last line to read (inclusive).

        Returns:
            The raw text of lines start through end, with line numbers
            prepended for AI readability.
        """
        lines = self.path.read_text(encoding="utf-8", errors="replace").splitlines()
        start = max(1, start)
        end = min(len(lines), end)
        selected = lines[start - 1:end]
        return "\n".join(f"{start + i:>5} │ {line}" for i, line in enumerate(selected))

    # ------------------------------------------------------------------ #
    # Mode 4 — Summarize                                                   #
    # ------------------------------------------------------------------ #

    def summarize(self) -> str:
        """
        Return a structured plain-text summary of the file.

        Combines outline + first 40 lines + last 20 lines into one block.
        No LLM required — fast and offline. Pass this to an AI as initial
        context before deciding which chunk to read next.

        Returns:
            Multi-line string: FILE, LANGUAGE, SIZE, STRUCTURE, HEAD, TAIL.
        """
        return summarize_file(str(self.path))
