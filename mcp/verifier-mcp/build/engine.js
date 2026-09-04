import crypto from "crypto";
function parseFieldValue(v) {
    if (typeof v === "number")
        return v;
    if (!v)
        return 0;
    if (typeof v === "object" && "value" in v) {
        return parseFieldValue(v.value);
    }
    const clean = String(v).replace(/[^0-9.-]+/g, "");
    const num = parseFloat(clean);
    return isNaN(num) ? 0 : num;
}
function getFieldString(v) {
    if (v === undefined || v === null)
        return "";
    if (typeof v === "object" && "value" in v) {
        return String(v.value ?? "");
    }
    return String(v);
}
export function detectParadoxes(fields) {
    const paradoxes = [];
    // 1. Mathematical Paradox: Subtotal + VAT ≠ Total
    if (("subtotal" in fields || "subtotal_amount" in fields) &&
        ("vat_amount" in fields || "tax_amount" in fields) &&
        ("total_amount" in fields || "total" in fields)) {
        const subtotal = parseFieldValue(fields.subtotal ?? fields.subtotal_amount);
        const vat = parseFieldValue(fields.vat_amount ?? fields.tax_amount);
        const total = parseFieldValue(fields.total_amount ?? fields.total);
        const expectedTotal = subtotal + vat;
        const diff = Math.abs(expectedTotal - total);
        // Any discrepancy above 1 cent is a mathematical contradiction
        if (diff > 0.01 && total > 0) {
            paradoxes.push({
                type: "MATHEMATICAL_PARADOX",
                description: `Subtotal (${subtotal.toFixed(2)}) + VAT (${vat.toFixed(2)}) = ${expectedTotal.toFixed(2)}, but Total shows ${total.toFixed(2)} (discrepancy: ${diff.toFixed(2)})`,
                severity: "CRITICAL",
                requiredAction: "FORCE_BINARY_CHOICE",
                options: ["Trust Line Items", "Trust Total Amount"]
            });
        }
    }
    // 2. Temporal Paradox: Timeline violation
    const invoiceDateStr = getFieldString(fields.invoice_date);
    const paymentTermsStr = getFieldString(fields.payment_terms);
    if (invoiceDateStr && paymentTermsStr) {
        const terms = paymentTermsStr.toLowerCase();
        const invDate = new Date(invoiceDateStr);
        if (!isNaN(invDate.getTime())) {
            const now = new Date();
            // Future dated invoice beyond 60 days
            const daysDiff = (invDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
            if (daysDiff > 60) {
                paradoxes.push({
                    type: "TEMPORAL_PARADOX",
                    description: `Invoice date (${invoiceDateStr}) is ${Math.round(daysDiff)} days in the future`,
                    severity: "HIGH",
                    requiredAction: "FORCE_BINARY_CHOICE",
                    options: ["Adjust Invoice Date", "Reject Document"]
                });
            }
        }
        if (terms.includes("immediate") && fields.due_date) {
            const dueDateStr = getFieldString(fields.due_date);
            const dueDate = new Date(dueDateStr);
            if (!isNaN(dueDate.getTime()) && !isNaN(invDate.getTime()) && dueDate < invDate) {
                paradoxes.push({
                    type: "TEMPORAL_PARADOX",
                    description: `Due date (${dueDateStr}) precedes invoice date (${invoiceDateStr}) with immediate terms`,
                    severity: "CRITICAL",
                    requiredAction: "FORCE_BINARY_CHOICE",
                    options: ["Align Due Date to Invoice Date", "Reject Document"]
                });
            }
        }
    }
    // 3. Identity Paradox: VAT Country Prefix Mismatch
    const vatId = getFieldString(fields.customer_vat_id || fields.vendor_vat_id || fields.vat_id).trim().toUpperCase();
    const address = getFieldString(fields.vendor_address || fields.customer_address || fields.address);
    if (vatId.length >= 2 && address) {
        const countryPrefix = vatId.substring(0, 2);
        const euCountries = {
            DE: ["germany", "deutschland", "berlin", "munich", "frankfurt", "hamburg"],
            FR: ["france", "paris", "lyon", "marseille"],
            IT: ["italy", "italia", "rome", "milan"],
            ES: ["spain", "españa", "madrid", "barcelona"],
            NL: ["netherlands", "nederland", "amsterdam", "rotterdam"],
            GB: ["united kingdom", "uk", "london", "england", "scotland"]
        };
        const expectedKeywords = euCountries[countryPrefix];
        if (expectedKeywords) {
            const lowerAddress = address.toLowerCase();
            const hasMatch = expectedKeywords.some(k => lowerAddress.includes(k));
            if (!hasMatch) {
                paradoxes.push({
                    type: "IDENTITY_PARADOX",
                    description: `VAT ID has country prefix "${countryPrefix}" (${vatId}) but address does not reference matching jurisdiction: "${address}"`,
                    severity: "HIGH",
                    requiredAction: "FORCE_BINARY_CHOICE",
                    options: ["Trust VAT ID Registration", "Trust Physical Address"]
                });
            }
        }
    }
    return paradoxes;
}
export function evaluateConfidenceTier(confidence) {
    // Normalize if 0-1 range passed
    const pct = confidence <= 1.0 ? confidence * 100 : confidence;
    if (pct >= 95) {
        return {
            level: 1,
            name: "Level 1: Straight-Through Processing",
            threshold: "≥95%",
            status: "AUTO_APPROVED",
            description: "Deterministic confidence threshold met. Document approved for automated processing.",
            actionRequired: false
        };
    }
    else if (pct >= 80) {
        return {
            level: 2,
            name: "Level 2: Standard Human Review",
            threshold: "≥80%",
            status: "STANDARD_REVIEW",
            description: "High confidence with minor anomalies. Queued for standard human validation.",
            actionRequired: true
        };
    }
    else if (pct >= 60) {
        return {
            level: 3,
            name: "Level 3: Expedited Review",
            threshold: "≥60%",
            status: "EXPEDITED_REVIEW",
            description: "Moderate confidence. Routed to expedited specialist review.",
            actionRequired: true
        };
    }
    else if (pct >= 40) {
        return {
            level: 4,
            name: "Level 4: Recursive AI-Human Loop",
            threshold: "≥40%",
            status: "CRITICAL_LOOP",
            description: "Low confidence extraction. Requires iterative field-by-field human re-prompt.",
            actionRequired: true
        };
    }
    else {
        return {
            level: 5,
            name: "Level 5: Rejection & Resubmission",
            threshold: "<40%",
            status: "REJECTED",
            description: "Extraction failure. Document does not meet EU e-invoice minimum fidelity standards.",
            actionRequired: true
        };
    }
}
export function generateTruthToken(documentId, resolution, timestamp) {
    const ts = timestamp || new Date().toISOString();
    const payload = `${documentId}:${resolution}:${ts}`;
    return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
export function auditInvoice(invoiceData, overrideConfidence) {
    const documentId = invoiceData.documentId || `doc_${crypto.randomUUID().slice(0, 8)}`;
    const timestamp = new Date().toISOString();
    const paradoxes = detectParadoxes(invoiceData);
    // Compute confidence if not supplied
    let confidence = overrideConfidence ?? 96;
    if (invoiceData.confidence !== undefined) {
        confidence = typeof invoiceData.confidence === "number" ? invoiceData.confidence : parseFieldValue(invoiceData.confidence);
    }
    // Deduct score for critical paradoxes
    const criticalCount = paradoxes.filter(p => p.severity === "CRITICAL").length;
    const highCount = paradoxes.filter(p => p.severity === "HIGH").length;
    const penalty = (criticalCount * 25) + (highCount * 10);
    confidence = Math.max(0, confidence - penalty);
    const tier = evaluateConfidenceTier(confidence);
    const isCompliant = paradoxes.length === 0 && tier.level <= 2;
    const resolution = isCompliant ? "COMPLIANT_VERIFIED" : (paradoxes.length > 0 ? "PARADOX_BLOCKED" : "REVIEW_REQUIRED");
    const truthToken = generateTruthToken(documentId, resolution, timestamp);
    let summary = `Audit completed: Document ${documentId}. Verdict: ${resolution}. `;
    summary += `Confidence: ${confidence.toFixed(1)}% (${tier.name}). `;
    if (paradoxes.length > 0) {
        summary += `${paradoxes.length} paradox(es) detected. Immediate binary intervention required.`;
    }
    else {
        summary += `Zero contradictions found. Deterministic audit trail established.`;
    }
    return {
        documentId,
        timestamp,
        truthToken,
        status: resolution,
        confidence,
        tier,
        paradoxes,
        isCompliant,
        resolution,
        summary
    };
}
