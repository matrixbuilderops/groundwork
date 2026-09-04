# verifier-mcp

> **"The model proposes; deterministic executed checks own the verdict."**

Deterministic EU e-Invoice compliance engine and paradox resolver. Exposed as a Model Context Protocol (MCP) server for AI coding agents and an instant CLI via `npx`.

Built from the DevNetwork API + Cloud + AI Hackathon 2026 project.

## Why verifier-mcp?

LLM extraction engines hallucinate and report misleading confidence scores on unstructured PDFs. When the EU September 2026 e-invoicing mandate takes effect, automated workflows cannot rely on fuzzy probabilistic guesses.

`verifier-mcp` wraps document extraction with **deterministic verification gates**:
1. **Contradiction / Paradox Detection**: Flags mathematical, temporal, and legal jurisdiction discrepancies before data enters accounting ledgers.
2. **5-Tier Confidence Hierarchy**: Routes extractions from Level 1 Straight-Through processing down to Level 5 hard rejection.
3. **Single Token Language**: Emits an immutable SHA-256 truth token (`document_id:resolution:timestamp`) as cryptographic audit evidence.

## Quick Start via NPX

Run directly without installation:

```bash
# Test built-in paradox checks
npx verifier-mcp test-paradox

# Audit a JSON invoice extraction
npx verifier-mcp audit ./invoice.json
```

## Setup as an MCP Server

Add to your AI agent configuration (Claude Desktop, Cursor, Antigravity):

```json
{
  "mcpServers": {
    "verifier": {
      "command": "npx",
      "args": ["-y", "verifier-mcp"]
    }
  }
}
```

## Tools Exposed

| Tool | Parameters | Description |
|---|---|---|
| `detect_paradoxes` | `fields: object` | Detects mathematical mismatches, causality violations, and VAT jurisdiction anomalies. |
| `evaluate_compliance_tier` | `confidence: number` | Maps confidence scores to the 5-tier EU regulatory review framework. |
| `generate_truth_token` | `documentId`, `resolution`, `timestamp?` | Generates SHA-256 immutable audit proof token. |
| `audit_invoice` | `invoiceData: object` | Full end-to-end verification audit producing compliance verdict and truth token. |
| `explain_paradox` | `paradoxType: string` | Returns deterministic mitigation steps for detected contradiction categories. |

## License

MIT © Alexander Sorrell
