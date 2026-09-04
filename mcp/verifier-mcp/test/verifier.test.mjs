import test from "node:test";
import assert from "node:assert/strict";
import {
  detectParadoxes,
  evaluateConfidenceTier,
  generateTruthToken,
  auditInvoice
} from "../build/engine.js";

test("detects mathematical paradox when subtotal + vat != total", () => {
  const invoice = {
    subtotal: 100,
    vat_amount: 20,
    total_amount: 150 // Bad math: 100 + 20 != 150
  };
  const paradoxes = detectParadoxes(invoice);
  assert.equal(paradoxes.length, 1);
  assert.equal(paradoxes[0].type, "MATHEMATICAL_PARADOX");
  assert.equal(paradoxes[0].severity, "CRITICAL");
});

test("passes mathematical check when numbers align", () => {
  const invoice = {
    subtotal: 100,
    vat_amount: 20,
    total_amount: 120
  };
  const paradoxes = detectParadoxes(invoice);
  assert.equal(paradoxes.length, 0);
});

test("evaluates confidence levels into 5 tiers", () => {
  assert.equal(evaluateConfidenceTier(98).level, 1);
  assert.equal(evaluateConfidenceTier(85).level, 2);
  assert.equal(evaluateConfidenceTier(65).level, 3);
  assert.equal(evaluateConfidenceTier(45).level, 4);
  assert.equal(evaluateConfidenceTier(20).level, 5);
});

test("generates deterministic 16-character SHA-256 truth token", () => {
  const token1 = generateTruthToken("DOC1", "APPROVED", "2026-09-04T00:00:00Z");
  const token2 = generateTruthToken("DOC1", "APPROVED", "2026-09-04T00:00:00Z");
  const token3 = generateTruthToken("DOC1", "REJECTED", "2026-09-04T00:00:00Z");

  assert.equal(token1.length, 16);
  assert.equal(token1, token2);
  assert.notEqual(token1, token3);
});

test("full audit reports clean verdict on valid invoice", () => {
  const invoice = {
    documentId: "INV-VALID",
    subtotal: 500,
    vat_amount: 100,
    total_amount: 600,
    confidence: 97
  };
  const verdict = auditInvoice(invoice);
  assert.equal(verdict.isCompliant, true);
  assert.equal(verdict.tier.level, 1);
  assert.equal(verdict.paradoxes.length, 0);
  assert.ok(verdict.truthToken);
});
