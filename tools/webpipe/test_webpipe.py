import os
import sys
import unittest
import json

pkg_dir = os.path.dirname(os.path.abspath(__file__))
if pkg_dir not in sys.path:
    sys.path.insert(0, pkg_dir)

from webpipe.logger import WebPipeLogger
from webpipe.auth import AuthDetector, AuthResolver

class TestWebPipe(unittest.TestCase):
    def test_01_logger(self):
        test_log = "/tmp/test_webpipe_audit.jsonl"
        if os.path.exists(test_log):
            os.remove(test_log)
        logger = WebPipeLogger(log_path=test_log, max_bytes=5000)
        logger.log_request_start("https://example.com", {"test": True})
        logger.log_page_state(
            url="https://example.com",
            title="Example Domain",
            http_status=200,
            is_signed_in=True,
            user_identifier="alexander.sorrell.it@gmail.com",
            auth_barrier=False,
            is_wrong_page=False,
            actions_taken=["loaded", "checked_auth"]
        )
        logger.log_data_extracted("https://example.com", 1000, 200, 2, 150)
        
        self.assertTrue(os.path.exists(test_log))
        with open(test_log, "r") as f:
            lines = [json.loads(l) for l in f if l.strip()]
        self.assertEqual(len(lines), 3)
        self.assertEqual(lines[0]["event"], "REQUEST_START")
        self.assertEqual(lines[1]["event"], "PAGE_STATE")
        self.assertEqual(lines[1]["details"]["is_signed_in"], True)
        self.assertEqual(lines[2]["event"], "DATA_EXTRACTED")
        self.assertEqual(lines[2]["details"]["savings_pct"], "80.0%")
        
        # Test session wipe
        logger.wipe_session()
        self.assertEqual(os.path.getsize(test_log), 0)
        print("✅ Test 1 Passed: Logger records JSONL audit trail, comprehensive page states, and supports wipe.")

    def test_02_auth_detector(self):
        # Test Cloudflare detection
        is_cf, r_cf = AuthDetector.check_is_challenge_wire(
            vendor_hits=["https://challenges.cloudflare.com/turnstile/v0/api.js"])
        self.assertTrue(is_cf)
        self.assertIn("challenge vendor", r_cf.lower())

        # Test login URL detection
        is_login, r_login = AuthDetector.check_is_challenge_wire(
            was_redirected=True, has_password_field=True)
        self.assertTrue(is_login)
        self.assertIn("password field", r_login.lower())

        # Test benign page
        is_clean, _ = AuthDetector.check_is_challenge_wire(doc_status=200)
        self.assertFalse(is_clean)
        print("✅ Test 2 Passed: Auth barrier detection correctly flags challenges & logins.")

    def test_03_mcp_server(self):
        from webpipe.mcp_server import WebPipeMCPServer
        server = WebPipeMCPServer()
        tools = server.list_tools()
        self.assertEqual(len(tools), 7)
        tool_names = [t["name"] for t in tools]
        self.assertIn("webpipe_get", tool_names)
        self.assertIn("webpipe_json", tool_names)
        self.assertIn("webpipe_inspect_tab", tool_names)
        self.assertIn("webpipe_action", tool_names)
        self.assertIn("webpipe_extract_form", tool_names)
        self.assertIn("webpipe_files", tool_names)
        self.assertIn("webpipe_logs", tool_names)
        print(f"✅ Test 3 Passed: WebPipe MCP Server initialized with {len(tools)} tools: {tool_names}.")

if __name__ == "__main__":
    unittest.main()
