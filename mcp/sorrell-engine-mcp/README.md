# sorrell-engine-mcp

> **"Current AI agents are tourists. The Sorrell Engine is a citizen."**

Browser-native neural operating system and Tiny Model Swarm built for the OpenAI WebMCP Challenge 2026. Exposed as a Model Context Protocol (MCP) server for AI coding agents and an instant CLI via `npx`.

## Architecture: Tiny Model Swarm (<3GB Footprint)

- **Router (SecureBERT, 149M params)**: Sub-10ms intent classification and specialist dispatch.
- **Code Specialist (Qwen-1.5B)**: Generates production code, component layouts, and full applications.
- **Logic Specialist (Gemma-2B)**: Deconstructs high-level objectives into deterministic sequential stages.

## Quick Start via NPX

Run directly without installation:

```bash
# Classify intent in <10ms
npx sorrell-engine-mcp classify "Build a Bitcoin vs Gold real-time price dashboard"

# Synthesize a complete web application bundle
npx sorrell-engine-mcp build "Bitcoin vs Gold price dashboard"

# Generate code
npx sorrell-engine-mcp code "FIFO queue with atomic fcntl lock in Python"
```

## Setup as an MCP Server

Add to your AI agent configuration (Claude Desktop, Cursor, Antigravity):

```json
{
  "mcpServers": {
    "sorrell-engine": {
      "command": "npx",
      "args": ["-y", "sorrell-engine-mcp"]
    }
  }
}
```

## Tools Exposed

| Tool | Parameters | Description |
|---|---|---|
| `classify_intent` | `input: string` | Sub-10ms SecureBERT intent classification routing to specialist models. |
| `build_application` | `description: string`, `framework?: string` | Synthesizes full applications into clean HTML/CSS/JS bundles. |
| `generate_component` | `componentType: string`, `data?: string` | Synthesizes modular UI components with state bindings. |
| `analyze_data` | `data: string`, `question?: string` | Analyzes CSV/JSON datasets, distributions, and flags outlier anomalies. |
| `write_code` | `requirement: string`, `language?: string` | Generates verified code with companion unit test assertions. |
| `swarm_plan` | `goal: string` | Deconstructs multi-step objectives into structured execution stages. |

## License

PolyForm Noncommercial License 1.0.0
Required Notice: Copyright SignalCore Inc. and Bastion Fold LLC
Required Notice: Commercial licensing: matrixbuilderops@proton.me
