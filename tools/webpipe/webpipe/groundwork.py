"""
Clients for Alexander Sorrell's own MCP packages, used as components.

webpipe was built from scratch and referenced none of these, so it hand-rolled
site structure discovery and verification that already shipped as:

  sitemap-mcp   -- site structure: pages, forms, API hints  (npx sitemap-mcp)
  verifier-mcp  -- deterministic verdicts + SHA-256 truth tokens (npx verifier-mcp)

Both speak MCP over stdio, so one small JSON-RPC client serves both.
Prefers a local build/ checkout and falls back to npx.
"""

import atexit
import json
import threading
import os
import subprocess
import time

HOME = os.path.expanduser("~")
LOCAL_BUILDS = {
    "sitemap-mcp": os.path.join(HOME, "Desktop/matrixbuilderops/mcp/sitemap-mcp/build/index.js"),
    "verifier-mcp": os.path.join(HOME, "Desktop/matrixbuilderops/mcp/verifier-mcp/build/index.js"),
}


class McpStdioClient:
    """
    PERSISTENT MCP stdio client.

    Spawning a fresh `node` per call cost ~1.4s per page in measured overhead,
    almost all of it process startup rather than work. The server is stateless
    between tool calls, so one long-lived process serves every call: the spawn
    is paid once and each later call is just a write and a read.

    The process is respawned automatically if it dies, and torn down at exit.
    """

    # One live server per package, shared process-wide. Every send/receive pair
    # is serialised: without the lock, two callers interleave on one stdio pipe
    # and each can consume the other's reply while scanning for its own id --
    # one gets a wrong answer, the other hangs to timeout. Fires on any parallel
    # use, e.g. processing two applications at once.
    _pool = {}
    _pool_lock = threading.Lock()

    def __init__(self, package, timeout=90):
        self.package = package
        self.timeout = timeout
        self._proc = None
        self._next_id = 1
        self._io_lock = threading.RLock()   # RLock: call_tool retries into itself

    @classmethod
    def shared(cls, package, timeout=90):
        """One live server per package for the life of the process."""
        with cls._pool_lock:
            client = cls._pool.get(package)
            if client is None:
                client = cls(package, timeout=timeout)
                cls._pool[package] = client
            return client

    def _command(self):
        local = LOCAL_BUILDS.get(self.package)
        if local and os.path.exists(local):
            return ["node", local]
        return ["npx", "-y", self.package]

    def _alive(self):
        return self._proc is not None and self._proc.poll() is None

    def _start(self):
        self._proc = subprocess.Popen(
            self._command(),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1,
        )
        self._next_id = 1
        self._send({"jsonrpc": "2.0", "id": self._take_id(), "method": "initialize",
                    "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "webpipe", "version": "1.0"}}})
        self._await_id(1)  # drain the initialize reply so it can't be mistaken for a result
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

    def _take_id(self):
        i = self._next_id
        self._next_id += 1
        return i

    def _send(self, obj):
        self._proc.stdin.write(json.dumps(obj) + "\n")
        self._proc.stdin.flush()

    def _await_id(self, want_id):
        """Read until the reply with this id. Other traffic (notifications,
        log lines) is skipped, so a stray message can never be read as a result."""
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            line = self._proc.stdout.readline()
            if not line:
                return None
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get("id") == want_id:
                return msg
        return None

    def call_tool(self, tool_name, arguments, _retry=True):
        """
        Returns (ok, payload). payload is the tool's text content, parsed as
        JSON when it is JSON, otherwise the raw string. On failure, ok is False
        and payload is the error string -- callers must treat a failure as
        UNDETERMINED, never as a pass.
        """
        try:
          with self._io_lock:
            if not self._alive():
                self._start()
            req_id = self._take_id()
            self._send({"jsonrpc": "2.0", "id": req_id, "method": "tools/call",
                        "params": {"name": tool_name, "arguments": arguments}})
            msg = self._await_id(req_id)
            if msg is None:
                # Server died or went quiet: respawn once, then give up honestly.
                self.close()
                if _retry:
                    return self.call_tool(tool_name, arguments, _retry=False)
                return False, f"no response within {self.timeout}s"
            if "error" in msg:
                return False, str(msg["error"])
            content = msg.get("result", {}).get("content", [])
            text = content[0].get("text", "") if content else ""
            try:
                return True, json.loads(text)
            except Exception:
                return True, text
        except (BrokenPipeError, OSError) as e:
            self.close()
            if _retry:
                return self.call_tool(tool_name, arguments, _retry=False)
            return False, str(e)
        except Exception as e:
            return False, str(e)

    def close(self):
        if self._proc is not None:
            try:
                self._proc.kill()
            except Exception:
                pass
            self._proc = None


@atexit.register
def _shutdown_mcp_servers():
    for client in McpStdioClient._pool.values():
        client.close()


class SiteMap:
    """sitemap-mcp -- what a site's structure is SUPPOSED to be, before we act."""

    def __init__(self, timeout=90):
        self.client = McpStdioClient.shared("sitemap-mcp", timeout=timeout)

    def outline(self, url):
        """
        Returns (ok, {pages, forms, api_hints, auth_required, raw}).
        site_outline returns human-readable text, so it is parsed into fields.
        """
        ok, payload = self.client.call_tool("site_outline", {"url": url})
        if not ok:
            return False, {"error": payload}
        if isinstance(payload, dict):
            return True, payload

        text = str(payload)
        out = {"pages": [], "forms": [], "api_hints": [],
               "auth_required": None, "raw": text}
        section = None
        for line in text.splitlines():
            s = line.strip()
            if s.startswith("AUTH REQUIRED:"):
                v = s.split(":", 1)[1].strip().lower()
                out["auth_required"] = True if v == "true" else (False if v == "false" else None)
                continue
            if s.startswith("PAGES"):
                section = "pages"; continue
            if s.startswith("API HINTS"):
                section = "api_hints"; continue
            if s.startswith("FORMS"):
                section = "forms"; continue
            if s and s.endswith(":") and s.isupper():
                section = None; continue
            if section and s:
                out[section].append(s)
        return True, out


class Verifier:
    """verifier-mcp -- the deterministic verdict. The model proposes; this owns it."""

    def __init__(self, timeout=90):
        self.client = McpStdioClient.shared("verifier-mcp", timeout=timeout)

    def evaluate_tier(self, confidence):
        """Domain-general: maps a 0-100 confidence to the 5-tier review framework."""
        return self.client.call_tool("evaluate_compliance_tier", {"confidence": confidence})

    def truth_token(self, document_id, resolution, timestamp=None):
        """Domain-general: SHA-256 audit proof over id:resolution:timestamp."""
        args = {"documentId": document_id, "resolution": resolution}
        if timestamp:
            args["timestamp"] = timestamp
        return self.client.call_tool("generate_truth_token", args)

    # NOTE: detect_paradoxes is deliberately NOT wrapped. Its rules are bound to
    # invoice fields (subtotal / vat_amount / customer_vat_id). Web submissions
    # have none of those, so it would find zero paradoxes and report a clean
    # verdict on unverified data -- worse than no check. Web contradiction rules
    # live in verify.py and emit verifier-mcp's own Paradox shape so they run
    # through this same tier + token pipeline.
