# filelens-mcp

MCP server for intelligent file reading. Designed for AI agents that already have file access tools but waste multiple round trips understanding a file's structure.

## The problem

Reading a file naively takes 3–4 tool calls:
```
read_file(header) → grep classes → read_file(section) → grep methods → read_file(method)
```

FileLens collapses that into **one call**.

## Install

Add to your `mcp.json`:

```json
{
  "mcpServers": {
    "filelens": {
      "command": "npx",
      "args": ["-y", "filelens-mcp"]
    }
  }
}
```

No install step. `npx` handles it automatically.

## Tools

### `file_fetch` — the power tool
Outline + targeted chunk in one call. Give it a file and a target, get back the full structure map AND the matching lines.

```
file_fetch("auth.py", "login method")
→ full outline + exact lines for login()
```

### `file_outline`
Scan file structure — classes, functions, headings with line numbers. Always call this first.

```
file_outline("auth.py")
→ class UserAuth  lines 18–120
    ├── login()   line 34
    └── logout()  line 89
```

### `file_search`
Keyword or regex search with surrounding context lines and exact line numbers.

```
file_search("auth.py", "token expired", contextLines=5)
→ matching lines + 5 lines of context
```

### `file_chunk`
Read a precise line range with line numbers.

```
file_chunk("auth.py", 34, 89)
→ lines 34–89 numbered
```

### `file_summarize`
Outline + first 40 lines + last 20 lines in one call. Use when you've never seen a file before.

## Part of groundwork

[github.com/matrixbuilderops/groundwork](https://github.com/matrixbuilderops/groundwork) — the foundational awareness layer for AI agents. Pair with [sitemap-mcp](https://www.npmjs.com/package/sitemap-mcp) for website awareness.
