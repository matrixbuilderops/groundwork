"""
Outline generator — scans a file and returns its structure:
classes, functions, sections, headings — with line numbers.

Supports: Python, JavaScript/TypeScript, Markdown, plain text.
"""
from __future__ import annotations
import re
from pathlib import Path
from dataclasses import dataclass, field


@dataclass
class OutlineNode:
    """A single structural element in a file."""
    kind: str          # "class", "function", "heading", "section"
    name: str
    start_line: int
    end_line: int | None = None
    children: list["OutlineNode"] = field(default_factory=list)

    def __str__(self) -> str:
        end = f"–{self.end_line}" if self.end_line else ""
        return f"{self.kind:<12} {self.name:<40} line {self.start_line}{end}"


@dataclass
class FileOutline:
    """Complete structural outline of a file."""
    path: str
    language: str
    total_lines: int
    nodes: list[OutlineNode]

    def render(self) -> str:
        """Return a tree-style text representation for AI consumption."""
        lines = [f"{self.path}  ({self.total_lines} lines, {self.language})"]
        for node in self.nodes:
            prefix = "├──" if node != self.nodes[-1] else "└──"
            end = f"–{node.end_line}" if node.end_line else ""
            lines.append(f"{prefix} {node.kind} {node.name}  lines {node.start_line}{end}")
            for i, child in enumerate(node.children):
                cp = "│   ├──" if i < len(node.children) - 1 else "│   └──"
                cend = f"–{child.end_line}" if child.end_line else ""
                lines.append(f"{cp} {child.name}()  line {child.start_line}{cend}")
        return "\n".join(lines)


def _detect_language(path: Path) -> str:
    # Kept in step with mcp/filelens-mcp/src/index.ts:detectLanguage. The two
    # copies had already drifted (that one carried .cpp/.c/.cs, this one did
    # not), and both were missing .mjs/.cjs — so an ES-module project read as
    # "text" and the JavaScript outliner never ran on it.
    ext_map = {
        ".py": "Python", ".js": "JavaScript", ".mjs": "JavaScript",
        ".cjs": "JavaScript", ".jsx": "JavaScript",
        ".ts": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
        ".tsx": "TypeScript", ".md": "Markdown",
        ".go": "Go", ".rs": "Rust", ".java": "Java", ".rb": "Ruby",
        ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
        ".json": "JSON", ".yaml": "YAML", ".yml": "YAML",
        ".toml": "TOML", ".html": "HTML", ".css": "CSS", ".cpp": "C++",
        ".c": "C", ".h": "C", ".hpp": "C++", ".cs": "C#",
    }
    return ext_map.get(path.suffix.lower(), "text")


def _outline_python(lines: list[str]) -> list[OutlineNode]:
    nodes: list[OutlineNode] = []
    current_class: OutlineNode | None = None

    for i, line in enumerate(lines, 1):
        stripped = line.rstrip()
        # Class definition
        m = re.match(r"^class\s+(\w+)", stripped)
        if m:
            if current_class:
                current_class.end_line = i - 1
            current_class = OutlineNode("class", m.group(1), i)
            nodes.append(current_class)
            continue
        # Function / method definition
        m = re.match(r"^(\s*)(?:async\s+)?def\s+(\w+)", stripped)
        if m:
            indent = len(m.group(1))
            name = m.group(2)
            node = OutlineNode("def", name, i)
            if indent > 0 and current_class:
                current_class.children.append(node)
            else:
                if current_class:
                    current_class.end_line = i - 1
                    current_class = None
                nodes.append(node)

    return nodes


def _outline_js(lines: list[str]) -> list[OutlineNode]:
    nodes: list[OutlineNode] = []
    patterns = [
        (r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)", "function"),
        (r"^(?:export\s+)?class\s+(\w+)", "class"),
        (r"^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(", "arrow fn"),
        (r"^\s+(?:async\s+)?(\w+)\s*\(", "method"),
    ]
    for i, line in enumerate(lines, 1):
        for pattern, kind in patterns:
            m = re.match(pattern, line)
            if m:
                nodes.append(OutlineNode(kind, m.group(1), i))
                break
    return nodes


def _outline_markdown(lines: list[str]) -> list[OutlineNode]:
    nodes: list[OutlineNode] = []
    for i, line in enumerate(lines, 1):
        m = re.match(r"^(#{1,3})\s+(.+)", line)
        if m:
            level = len(m.group(1))
            heading = m.group(2).strip()
            nodes.append(OutlineNode(f"h{level}", heading, i))
    return nodes


def build_outline(path: str) -> FileOutline:
    """
    Scan a file and return its structural outline.
    This is always the first call an AI agent should make — it tells
    the AI what is in the file before reading any content.
    """
    p = Path(path)
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    lang = _detect_language(p)

    if lang == "Python":
        nodes = _outline_python(lines)
    elif lang in ("JavaScript", "TypeScript"):
        nodes = _outline_js(lines)
    elif lang == "Markdown":
        nodes = _outline_markdown(lines)
    else:
        nodes = []

    return FileOutline(
        path=str(p),
        language=lang,
        total_lines=len(lines),
        nodes=nodes,
    )
