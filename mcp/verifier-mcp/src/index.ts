#!/usr/bin/env node
/**
 * Verifier MCP Server & NPX Runner
 *
 * EU e-Invoice Document Compliance & Paradox Resolver.
 * Replaces fuzzy AI trust with deterministic executed checks and immutable audit tokens.
 *
 * Tools exposed:
 *   detect_paradoxes          — Scan invoice data for mathematical, temporal, or identity contradictions
 *   evaluate_compliance_tier  — Route confidence score through 5-level EU regulatory matrix
 *   generate_truth_token      — Generate single-token SHA-256 cryptographic audit trail entry
 *   audit_invoice             — End-to-end audit pipeline producing compliance verdict & token
 *   explain_paradox           — Detailed mitigation steps for detected contradictions
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import {
  detectParadoxes,
  evaluateConfidenceTier,
  generateTruthToken,
  auditInvoice,
  InvoiceData
} from "./engine.js";

const VERSION = "1.0.0";
const args = process.argv.slice(2);

// If run from terminal with CLI arguments (not piped MCP stdio)
if (args.length > 0 && !process.env.MCP_FORCE_STDIO) {
  handleCli(args);
} else {
  startMcpServer().catch((err) => {
    console.error("Verifier MCP Fatal Error:", err);
    process.exit(1);
  });
}

function handleCli(cliArgs: string[]) {
  const first = cliArgs[0];

  if (first === "--help" || first === "-h" || first === "help") {
    console.log(`
Verifier - EU e-Invoice Compliance Engine & Paradox Resolver (v${VERSION})
"The model proposes; deterministic executed checks own the verdict."

Usage:
  npx verifier-mcp                            Start MCP server (stdio mode for AI agents)
  npx verifier-mcp audit <invoice.json>       Audit invoice JSON file
  npx verifier-mcp verify --subtotal 100 --vat 20 --total 120
  npx verifier-mcp test-paradox               Run built-in paradox test cases
  npx verifier-mcp --version                  Show version

Environment Variables:
  NUTRIENT_API_KEY      Optional Nutrient DWS API key
  NUTRIENT_API_SECRET   Optional Nutrient DWS secret
`);
    process.exit(0);
  }

  if (first === "--version" || first === "-v") {
    console.log(`verifier-mcp v${VERSION}`);
    process.exit(0);
  }

  if (first === "test-paradox") {
    console.log("⚡ Running Verifier Paradox Detection Suite...\n");
    const badInvoice: InvoiceData = {
      documentId: "INV-2026-PARADOX",
      subtotal: 1000.00,
      vat_amount: 190.00,
      total_amount: 1250.00, // Contradiction: 1000 + 190 != 1250
      customer_vat_id: "DE123456789",
      vendor_address: "124 Baker St, London, UK", // Contradiction: DE VAT in UK address
      confidence: 96
    };

    const verdict = auditInvoice(badInvoice);
    console.log(JSON.stringify(verdict, null, 2));
    process.exit(0);
  }

  if (first === "audit" && cliArgs[1]) {
    const targetPath = path.resolve(cliArgs[1]);
    if (!fs.existsSync(targetPath)) {
      console.error(`File not found: ${targetPath}`);
      process.exit(1);
    }
    try {
      const data = JSON.parse(fs.readFileSync(targetPath, "utf8"));
      const verdict = auditInvoice(data);
      console.log(JSON.stringify(verdict, null, 2));
      process.exit(verdict.isCompliant ? 0 : 2);
    } catch (e: any) {
      console.error(`Failed to parse or audit JSON: ${e.message}`);
      process.exit(1);
    }
  }

  // Fallback to launching MCP server
  startMcpServer().catch((err) => {
    console.error("Verifier MCP Fatal Error:", err);
    process.exit(1);
  });
}

async function startMcpServer() {
  const server = new McpServer({
    name: "verifier-mcp",
    version: VERSION
  });

  // Tool 1: detect_paradoxes
  server.tool(
    "detect_paradoxes",
    "Detect logical impossibilities (mathematical discrepancies, temporal causality violations, identity mismatches) in extracted invoice fields.",
    {
      fields: z.record(z.any()).describe("Key-value dictionary of invoice fields (subtotal, vat_amount, total_amount, invoice_date, payment_terms, customer_vat_id, vendor_address)")
    },
    async ({ fields }) => {
      try {
        const paradoxes = detectParadoxes(fields);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  paradoxCount: paradoxes.length,
                  hasParadox: paradoxes.length > 0,
                  paradoxes
                },
                null,
                2
              )
            }
          ]
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error detecting paradoxes: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool 2: evaluate_compliance_tier
  server.tool(
    "evaluate_compliance_tier",
    "Route an extraction confidence score through the 5-tier EU e-invoice validation matrix (Level 1 Straight-Through to Level 5 Rejection).",
    {
      confidence: z.number().describe("Confidence score (either 0.0-1.0 or 0-100 percentage)")
    },
    async ({ confidence }) => {
      try {
        const tier = evaluateConfidenceTier(confidence);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(tier, null, 2) }]
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error evaluating tier: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool 3: generate_truth_token
  server.tool(
    "generate_truth_token",
    "Emit a single-token cryptographic SHA-256 audit entry verifying that an invoice resolution occurred at an exact timestamp.",
    {
      documentId: z.string().describe("Unique identifier of the invoice or document"),
      resolution: z.string().describe("Audit resolution string (e.g. COMPLIANT_VERIFIED, MANUAL_OVERRIDE_APPROVED, REJECTED)"),
      timestamp: z.string().optional().describe("ISO timestamp (defaults to current time if omitted)")
    },
    async ({ documentId, resolution, timestamp }) => {
      try {
        const token = generateTruthToken(documentId, resolution, timestamp);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  documentId,
                  resolution,
                  timestamp: timestamp || new Date().toISOString(),
                  truthToken: token,
                  proofFormula: "SHA256(documentId:resolution:timestamp)[:16]"
                },
                null,
                2
              )
            }
          ]
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error generating truth token: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool 4: audit_invoice
  server.tool(
    "audit_invoice",
    "Perform a complete deterministic compliance audit on an invoice: detects paradoxes, applies confidence tiering, and emits an immutable truth token.",
    {
      invoiceData: z.record(z.any()).describe("JSON invoice object containing extracted fields and optional confidence score"),
      overrideConfidence: z.number().optional().describe("Optional manual confidence score override")
    },
    async ({ invoiceData, overrideConfidence }) => {
      try {
        const verdict = auditInvoice(invoiceData, overrideConfidence);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(verdict, null, 2) }]
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error during invoice audit: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool 5: explain_paradox
  server.tool(
    "explain_paradox",
    "Retrieve deterministic mitigation strategies for a given paradox type (MATHEMATICAL_PARADOX, TEMPORAL_PARADOX, IDENTITY_PARADOX).",
    {
      paradoxType: z.string().describe("The paradox type to explain")
    },
    async ({ paradoxType }) => {
      const explanations: Record<string, any> = {
        MATHEMATICAL_PARADOX: {
          description: "Subtotal + VAT does not equal Total Amount.",
          rootCause: "OCR bounding box misread, currency rounding inconsistency, or undisclosed line item discount.",
          remedy: "Force binary choice: Either recalculate total deterministically from line items or flag discrepancy to human auditor before signing."
        },
        TEMPORAL_PARADOX: {
          description: "Payment due date precedes invoice creation date or invoice is post-dated beyond regulatory bounds.",
          rootCause: "Vendor billing system clock skew or DD/MM vs MM/DD format misparsing.",
          remedy: "Align due date to creation date + standard payment term window, or prompt user to verify document date format."
        },
        IDENTITY_PARADOX: {
          description: "VAT registration country prefix does not match company legal entity address jurisdiction.",
          rootCause: "Cross-border subsidiary billing or misattributed VAT number from sister entity.",
          remedy: "Verify European VIES database for legal entity registration or enforce VAT country code match."
        }
      };

      const info = explanations[paradoxType.toUpperCase()] || {
        description: `Generic paradox category: ${paradoxType}`,
        remedy: "Flag document for Level 4 recursive AI-human loop validation."
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }]
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("verifier-mcp server running on stdio");
}
