#!/usr/bin/env node
/**
 * Sorrell Engine MCP Server & NPX Runner
 *
 * Browser-native Neural Operating System and Tiny Model Swarm (WebMCP).
 * Routes natural language intent into deterministic applications, components, and code.
 *
 * Swarm Specialists:
 *   Router: SecureBERT (149M) — sub-10ms intent classification
 *   Coder:  Qwen-1.5B         — Code & application synthesis
 *   Logic:  Gemma-2B          — Reasoning & multi-step planning
 *
 * Tools exposed:
 *   classify_intent    — Fast intent routing with specialist selection
 *   build_application  — Generates complete web application with single-file bundle
 *   generate_component — Synthesizes UI components with props & styles
 *   analyze_data       — Deterministic analysis of CSV/JSON data with anomaly flags
 *   write_code         — Generates production code in specified programming language
 *   swarm_plan         — Decomposes goals into executable sequential stages
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ModelSwarm } from "./swarm.js";
const VERSION = "1.0.0";
const swarm = new ModelSwarm();
const args = process.argv.slice(2);
if (args.length > 0 && !process.env.MCP_FORCE_STDIO) {
    handleCli(args);
}
else {
    startMcpServer().catch((err) => {
        console.error("Sorrell Engine MCP Fatal Error:", err);
        process.exit(1);
    });
}
function handleCli(cliArgs) {
    const first = cliArgs[0];
    if (first === "--help" || first === "-h" || first === "help") {
        console.log(`
Sorrell Engine - WebMCP Native OS & Model Swarm (v${VERSION})
"Current AI agents are tourists. The Sorrell Engine is a citizen."

Usage:
  npx sorrell-engine-mcp                      Start MCP server (stdio mode for AI agents)
  npx sorrell-engine-mcp build "<prompt>"     Generate an application from prompt
  npx sorrell-engine-mcp classify "<text>"    Classify intent via SecureBERT
  npx sorrell-engine-mcp code "<task>"        Generate code for a task
  npx sorrell-engine-mcp --version            Show version
`);
        process.exit(0);
    }
    if (first === "--version" || first === "-v") {
        console.log(`sorrell-engine-mcp v${VERSION}`);
        process.exit(0);
    }
    if (first === "classify" && cliArgs[1]) {
        const text = cliArgs.slice(1).join(" ");
        const res = swarm.classifyIntent(text);
        console.log(JSON.stringify(res, null, 2));
        process.exit(0);
    }
    if (first === "build" && cliArgs[1]) {
        const prompt = cliArgs.slice(1).join(" ");
        const app = swarm.buildApplication(prompt);
        console.log(`\n=== GENERATED APPLICATION: ${app.title} ===\n`);
        console.log(app.bundle);
        process.exit(0);
    }
    if (first === "code" && cliArgs[1]) {
        const task = cliArgs.slice(1).join(" ");
        const result = swarm.writeCode(task);
        console.log(`\n// Language: ${result.language}\n${result.code}`);
        process.exit(0);
    }
    startMcpServer().catch((err) => {
        console.error("Sorrell Engine MCP Fatal Error:", err);
        process.exit(1);
    });
}
async function startMcpServer() {
    const server = new McpServer({
        name: "sorrell-engine-mcp",
        version: VERSION
    });
    // Tool 1: classify_intent
    server.tool("classify_intent", "Sub-10ms intent classification via SecureBERT router. Determines whether a request requires UI, full-stack app, data analysis, or logic planning.", {
        input: z.string().describe("User prompt or natural language directive")
    }, async ({ input }) => {
        try {
            const res = swarm.classifyIntent(input);
            return {
                content: [{ type: "text", text: JSON.stringify(res, null, 2) }]
            };
        }
        catch (err) {
            return {
                content: [{ type: "text", text: `Error classifying intent: ${err.message}` }],
                isError: true
            };
        }
    });
    // Tool 2: build_application
    server.tool("build_application", "Build a complete web application from a natural language prompt. Returns structured HTML, CSS, JavaScript, and a ready-to-render single-file bundle.", {
        description: z.string().describe("Natural language description of the application to synthesize"),
        framework: z.string().optional().describe("Target runtime environment (vanilla, react, html)")
    }, async ({ description, framework }) => {
        try {
            const app = swarm.buildApplication(description, framework);
            return {
                content: [{ type: "text", text: JSON.stringify(app, null, 2) }]
            };
        }
        catch (err) {
            return {
                content: [{ type: "text", text: `Error building application: ${err.message}` }],
                isError: true
            };
        }
    });
    // Tool 3: generate_component
    server.tool("generate_component", "Generate a specific UI component (metric card, chart, form, navigation) with integrated styling and state bindings.", {
        componentType: z.string().describe("Type of component (e.g. chart, metric_card, search_bar, modal)"),
        data: z.string().optional().describe("Optional context or data payload"),
        framework: z.string().optional().describe("Target framework (html, react)")
    }, async ({ componentType, data, framework }) => {
        try {
            const markup = swarm.generateComponent(componentType, data, framework);
            return {
                content: [{ type: "text", text: markup }]
            };
        }
        catch (err) {
            return {
                content: [{ type: "text", text: `Error generating component: ${err.message}` }],
                isError: true
            };
        }
    });
    // Tool 4: analyze_data
    server.tool("analyze_data", "Deterministically analyze CSV or JSON datasets: parses rows, computes min/max/mean distributions, and flags anomalous outlier records.", {
        data: z.string().describe("Raw CSV or JSON dataset string"),
        question: z.string().optional().describe("Specific analytical question to address")
    }, async ({ data, question }) => {
        try {
            const analysis = swarm.analyzeData(data, question);
            return {
                content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }]
            };
        }
        catch (err) {
            return {
                content: [{ type: "text", text: `Error analyzing data: ${err.message}` }],
                isError: true
            };
        }
    });
    // Tool 5: write_code
    server.tool("write_code", "Write production-grade code with accompanying test assertions for a given technical requirement.", {
        requirement: z.string().describe("What the code should accomplish"),
        language: z.string().optional().describe("Programming language (typescript, python, javascript, rust)")
    }, async ({ requirement, language }) => {
        try {
            const result = swarm.writeCode(requirement, language);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
        }
        catch (err) {
            return {
                content: [{ type: "text", text: `Error generating code: ${err.message}` }],
                isError: true
            };
        }
    });
    // Tool 6: swarm_plan
    server.tool("swarm_plan", "Deconstruct high-level goals into deterministic sequential stages mapped to specialized model tools via Gemma-2B logic parser.", {
        goal: z.string().describe("High-level goal or objective to decompose")
    }, async ({ goal }) => {
        try {
            const plan = swarm.plan(goal);
            return {
                content: [{ type: "text", text: JSON.stringify(plan, null, 2) }]
            };
        }
        catch (err) {
            return {
                content: [{ type: "text", text: `Error planning goal: ${err.message}` }],
                isError: true
            };
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("sorrell-engine-mcp server running on stdio");
}
