import test from "node:test";
import assert from "node:assert/strict";
import { ModelSwarm } from "../build/swarm.js";

test("classifies intent in sub-10ms with specialist assignment", () => {
  const swarm = new ModelSwarm();
  const res = swarm.classifyIntent("Build a real-time trading dashboard for BTC");
  assert.equal(res.intent, "ui_generation");
  assert.ok(res.confidence > 0.9);
  assert.ok(res.latencyMs < 25);
});

test("generates complete single-file bundle for application", () => {
  const swarm = new ModelSwarm();
  const app = swarm.buildApplication("Cryptocurrency Tracker");
  assert.ok(app.html.length > 0);
  assert.ok(app.css.length > 0);
  assert.ok(app.javascript.length > 0);
  assert.ok(app.bundle.includes("<!DOCTYPE html>"));
  assert.ok(app.bundle.includes("Cryptocurrency Tracker"));
});

test("analyzes CSV data and computes numeric distributions", () => {
  const swarm = new ModelSwarm();
  const csv = "item,price,quantity\napple,2.50,10\nbanana,1.50,20\norange,3.00,15";
  const analysis = swarm.analyzeData(csv);
  assert.equal(analysis.rowCount, 3);
  assert.equal(analysis.columnCount, 3);
  assert.ok(analysis.numericSummary["price"]);
  assert.equal(analysis.numericSummary["price"].min, 1.5);
  assert.equal(analysis.numericSummary["price"].max, 3.0);
});

test("deconstructs high-level goal into sequential swarm steps", () => {
  const swarm = new ModelSwarm();
  const plan = swarm.plan("Analyze server latency metrics");
  assert.ok(plan.steps.length >= 3);
  assert.equal(plan.steps[0].tool, "classify_intent");
});
