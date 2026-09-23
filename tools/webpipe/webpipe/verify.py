"""
Three-stage verification for webpipe, built from Alexander Sorrell's own packages.

    BEFORE   sitemap-mcp   what the site's structure SAYS it is  (no browser, no session)
    DURING   webpipe       what the WIRE actually did            (real session, JS runs)
    AFTER    verifier-mcp  the deterministic VERDICT + truth token

The point is contradiction, not description. One tool alone can be fooled:
sitemap-mcp fetches without JS and misses client-side auth walls; the browser
alone cannot tell "this page is gone" from "this page bounced me". Where the two
disagree, that disagreement IS the finding.

Rules here emit verifier-mcp's Paradox shape {type, description, severity,
requiredAction, options} so they flow through its tier + truth-token pipeline
instead of a second, parallel verification layer.
"""

from .groundwork import SiteMap, Verifier
from urllib.parse import urlsplit

from .urlnorm import norm_url as _norm


def _host(u):
    try:
        h = urlsplit(u or "").netloc.lower()
        return h[4:] if h.startswith("www.") else h
    except Exception:
        return ""


def _path(u):
    try:
        return (urlsplit(u or "").path or "/").rstrip("/").lower() or "/"
    except Exception:
        return "/"

# Confidence penalties per severity. Confidence feeds verifier-mcp's 5-tier
# framework, where Level 1 is straight-through and Level 5 is rejection.
SEVERITY_COST = {"CRITICAL": 45, "HIGH": 25, "MEDIUM": 12, "LOW": 5}


def detect_web_paradoxes(expected, observed, intended_fields=None):
    """
    expected: dict from SiteMap.outline() (or {} when unavailable)
    observed: dict from a webpipe query -- requested_url, landed_url, doc_status,
              challenge, posts_sent, api_hints_seen
    intended_fields: {field_name: value_we_meant_to_submit}, optional

    Returns a list of Paradox dicts. An empty list means no CONTRADICTION was
    found -- it does not by itself mean verified. The caller still checks
    whether evidence was actually observed.
    """
    paradoxes = []
    requested = observed.get("requested_url")
    landed = observed.get("landed_url")

    # 1. DESTINATION -- we asked for one page and the browser ended up elsewhere.
    #    Catches client-side/SPA router bounces that emit no HTTP 3xx.
    if requested and landed and _norm(requested) != _norm(landed):
        # Not every redirect is a failure. dice.com/profile -> /profile/info is
        # a site resolving its own canonical path, and blocking that made a
        # perfectly good signed-in page read as PARADOX_BLOCKED. What matters is
        # WHERE it went: off the origin entirely is how auth walls and bot
        # interstitials look; a deeper path on the same host is just routing.
        req_host, landed_host = _host(requested), _host(landed)
        cross_origin = req_host != landed_host
        req_path, landed_path = _path(requested), _path(landed)
        canonical = (not cross_origin) and (
            landed_path.startswith(req_path) or req_path.startswith(landed_path)
        )

        if cross_origin:
            paradoxes.append({
                "type": "DESTINATION_PARADOX",
                "description": (
                    f"Requested {requested} but landed on a DIFFERENT HOST: {landed}. "
                    "An off-origin bounce is how sign-in redirects and bot "
                    "interstitials present, even with no password field and a 200."
                ),
                "severity": "CRITICAL",
                "requiredAction": "FORCE_BINARY_CHOICE",
                "options": ["Treat as auth wall and resolve", "Accept the landed page as correct"],
            })
        elif not canonical:
            paradoxes.append({
                "type": "DESTINATION_PARADOX",
                "description": f"Requested {requested} but landed on {landed} (same host, different section)",
                "severity": "CRITICAL" if observed.get("challenge") else "HIGH",
                "requiredAction": "FORCE_BINARY_CHOICE",
                "options": ["Treat as auth wall and resolve", "Accept the landed page as correct"],
            })
        else:
            paradoxes.append({
                "type": "CANONICAL_REDIRECT",
                "description": f"{requested} resolved to its canonical path {landed} (same host)",
                "severity": "LOW",
                "requiredAction": "NONE",
                "options": ["Accept"],
            })

    # 1b. CHALLENGE ITSELF. A wall served AT the requested URL changes nothing
    #     about the URL and nothing sitemap-mcp can see, so until now none of the
    #     other rules fired and a Cloudflare Turnstile page returned VERIFIED.
    #     A challenge means the bytes we got are the wall, not the page.
    if observed.get("challenge"):
        paradoxes.append({
            "type": "CHALLENGE_PARADOX",
            "description": (
                "A bot/auth challenge was observed on this page "
                f"({observed.get('challenge_reason') or 'reason unrecorded'}). "
                "The content returned is the challenge, not the page requested."
            ),
            "severity": "CRITICAL",
            "requiredAction": "RESOLVE_CHALLENGE",
            "options": ["Solve it in the headed browser and retry", "Abort this target"],
        })

    # 2. AUTH DISAGREEMENT -- the whole reason to run two tools. sitemap-mcp
    #    fetches without JS; the browser runs it. When they disagree, the
    #    structural read was blind to a client-side wall.
    site_auth = expected.get("auth_required")
    wire_auth = observed.get("challenge")
    if site_auth is False and wire_auth is True:
        paradoxes.append({
            "type": "AUTH_PARADOX",
            "description": (
                "sitemap-mcp reports AUTH REQUIRED: false, but the browser hit a "
                f"challenge ({observed.get('challenge_reason')}). The structural "
                "fetch ran without JS and missed a client-side auth wall."
            ),
            "severity": "HIGH",
            "requiredAction": "TRUST_WIRE_OVER_STRUCTURE",
            "options": ["Resolve the wall in the headed browser", "Abort this target"],
        })

    # 3. SUBMISSION REJECTION -- the server's own answer to what we sent.
    #    The single most direct proof a submission failed, and it was being
    #    logged and ignored: a POST can hit the right endpoint with the right
    #    values and come back 422 Unprocessable or 409 Already Applied. Without
    #    this rule that reads as VERIFIED, which is how a tracker ends up with a
    #    row for an application that never went through.
    for post in observed.get("posts_sent", []):
        url = post.get("url", "")
        try:
            status = int(post.get("status"))
        except (TypeError, ValueError):
            status = None
        if _is_telemetry(url) or status is None:
            continue
        if status >= 400:
            paradoxes.append({
                "type": "SUBMISSION_REJECTION_PARADOX",
                "description": (
                    f"{post.get('method')} {url} was REJECTED by the server: "
                    f"HTTP {status} (observed). The submission did not succeed."
                ),
                "severity": "CRITICAL",
                "requiredAction": "BLOCK_SUBMIT",
                "options": ["Fix the rejected field and resubmit", "Abort and record as failed"],
            })

    # 4. ENDPOINT -- a submission went somewhere the site's own structure never
    #    advertised. Telemetry beacons are excluded; they are not submissions.
    #    Severity depends on what it was: reading from an undiscovered endpoint
    #    is a note, but a POST landing somewhere unexpected means the data went
    #    out to a place the tracker does not believe it went, so it blocks.
    hints = [h for h in expected.get("api_hints", []) if h]
    for post in observed.get("posts_sent", []):
        url = post.get("url", "")
        if _is_telemetry(url):
            continue
        if hints and not any(h.strip("/") in url for h in hints):
            is_write = (post.get("method") or "").upper() in ("POST", "PUT", "PATCH")
            paradoxes.append({
                "type": "ENDPOINT_PARADOX",
                "description": (
                    f"{post.get('method')} sent to {url}, which is not among the "
                    f"endpoints sitemap-mcp discovered ({', '.join(hints[:4])})"
                ),
                "severity": "HIGH" if is_write else "MEDIUM",
                "requiredAction": "CONFIRM_TARGET",
                "options": ["Accept as an undiscovered endpoint", "Halt and inspect"],
            })

    # 4. FIELD -- the value we meant to submit is absent from the body actually
    #    sent. This is the GLG slider failure in general form: the control
    #    displayed $350 while the form committed nothing.
    # 5. UNREADABLE SUBMISSION -- runs ALWAYS, not only when intended_fields was
    #    supplied. It was previously nested under `if intended_fields:`, and the
    #    main path (smart_query -> verify(wire)) passes none, so the check never
    #    executed where it mattered. A body we could not read is not a body that
    #    checked out: Chrome omits postData for multipart/form-data, which is
    #    every resume upload.
    submissions = [p for p in observed.get("posts_sent", []) if not _is_telemetry(p.get("url"))]
    unreadable = [p for p in submissions if not p.get("post_data")]
    if unreadable:
        # Severity depends on whether we were SUBMITTING. Reading a page fires
        # background POSTs all the time -- profile toggles, session pings, API
        # writes -- and their bodies are often unreadable. That is not a failed
        # submission and must not block a page read, which is what it did on
        # dice.com/profile. It only matters when we intended to submit values:
        # then an unverifiable body is the resume-upload case that has to stop.
        submitting = bool(intended_fields)
        paradoxes.append({
            "type": "UNREADABLE_SUBMISSION" if submitting else "UNREADABLE_BODY_NOTE",
            "description": (
                f"{len(unreadable)} submission(s) carried a body that could not be read "
                f"off the wire (first: {unreadable[0].get('method')} {unreadable[0].get('url')}). "
                "Field values in it are UNVERIFIED -- typically multipart/form-data, "
                "e.g. a resume upload."
            ),
            "severity": "HIGH" if submitting else "LOW",
            "requiredAction": "CONFIRM_MANUALLY" if submitting else "NONE",
            "options": ["Confirm the submission on screen", "Re-submit and capture the body"],
        })

    # 6. FIELD -- the value we meant to submit is absent from the body actually
    #    sent. The GLG slider failure in general form.
    if intended_fields:
        bodies = " ".join(str(p.get("post_data") or "") for p in submissions)
        if bodies.strip():
            for name, value in intended_fields.items():
                if value in (None, ""):
                    continue
                if str(value) not in bodies:
                    paradoxes.append({
                        "type": "FIELD_PARADOX",
                        "description": (
                            f"Field '{name}' was set to '{value}' in the UI, but that "
                            "value does not appear in any submitted request body."
                        ),
                        "severity": "CRITICAL",
                        "requiredAction": "BLOCK_SUBMIT",
                        "options": ["Re-commit the control and retry", "Abort submission"],
                    })

    return paradoxes


SUBMIT_PATH_HINTS = ("apply", "submit", "application", "candidate", "register", "checkout")


def _is_telemetry(url):
    """
    Beacons are not submissions. Matching bare substrings over the whole URL got
    this wrong in both directions -- 'analytics' matched analytics.myats.com/submit
    and suppressed a real rejection. Host and path are now judged separately, and
    a submission-shaped path is never classed as telemetry.
    """
    from urllib.parse import urlsplit
    try:
        parts = urlsplit((url or "").lower())
    except Exception:
        return False
    host, path = parts.netloc, parts.path

    if any(h in path for h in SUBMIT_PATH_HINTS):
        return False

    host_marks = ("collector.", "sentry.", "doubleclick.", "segment.io",
                  "analytics.", "telemetry.", "mixpanel.", "amplitude.")
    path_marks = ("/api/event", "/collect", "/beacon", "/telemetry", "/track")
    return any(h in host for h in host_marks) or any(pm in path for pm in path_marks)


def verify(observed, expected=None, intended_fields=None, document_id=None,
           fetch_expected=True, verifier=None, sitemap=None):
    """
    Runs the full chain and returns a verdict dict.

    Fail-closed. verified is True only when a document response was actually
    observed AND no paradox was found. Missing evidence yields UNDETERMINED,
    never a pass -- absence of a contradiction is not proof of success.
    """
    sitemap = sitemap or SiteMap()
    verifier = verifier or Verifier()
    requested = observed.get("requested_url") or observed.get("landed_url")

    if expected is None and fetch_expected and requested:
        ok, out = sitemap.outline(requested)
        expected = out if ok else {"error": out.get("error"), "api_hints": []}
    expected = expected or {"api_hints": []}

    paradoxes = detect_web_paradoxes(expected, observed, intended_fields)

    # Only CRITICAL/HIGH block. A MEDIUM note -- e.g. a POST to an endpoint the
    # structural crawl never advertised -- is worth recording, but it is not
    # grounds to call a correctly fetched page untrusted. A verifier that flags
    # good pages gets ignored, and then it protects nothing.
    blocking = [p for p in paradoxes if p["severity"] in ("CRITICAL", "HIGH")]

    confidence = 100
    for p in paradoxes:
        confidence -= SEVERITY_COST.get(p["severity"], 10)
    # No observed document response means we have no evidence at all, whatever
    # the page looked like. Cap confidence so this can never route to Level 1.
    evidence_observed = observed.get("doc_status") is not None
    if not evidence_observed:
        confidence = min(confidence, 40)
    confidence = max(0, min(100, confidence))

    tier_ok, tier = verifier.evaluate_tier(confidence)
    if blocking:
        resolution = "PARADOX_BLOCKED"
    elif not evidence_observed:
        resolution = "UNDETERMINED_NO_EVIDENCE"
    elif paradoxes:
        resolution = "VERIFIED_WITH_NOTES"
    else:
        resolution = "VERIFIED"
    doc_id = document_id or requested or "webpipe-unknown"
    token_ok, token = verifier.truth_token(doc_id, resolution)

    # A dead verifier backend must not read as a pass. No truth token means the
    # deterministic verdict never actually ran, whatever the local rules found.
    verifier_ok = bool(token_ok and token)
    if not verifier_ok and resolution in ("VERIFIED", "VERIFIED_WITH_NOTES"):
        resolution = "UNDETERMINED_VERIFIER_UNAVAILABLE"

    return {
        "document_id": doc_id,
        "resolution": resolution,
        "verified": bool(evidence_observed and not blocking and verifier_ok),
        "verifier_available": verifier_ok,
        "blocking_paradoxes": len(blocking),
        "confidence": confidence,
        "evidence_observed": evidence_observed,
        "paradoxes": paradoxes,
        "tier": tier if tier_ok else {"error": tier},
        "truth_token": token if token_ok else None,
        "truth_token_error": None if token_ok else token,
        "expected_source": "sitemap-mcp" if expected.get("raw") else expected.get("error"),
        "observed_source": "webpipe wire (CDP Network)",
    }
