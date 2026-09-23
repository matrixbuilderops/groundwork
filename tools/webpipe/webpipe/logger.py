import json
import os
import time
import glob
import shutil
from datetime import datetime, timezone

DEFAULT_LOG_PATH = os.path.expanduser("~/Desktop/matrixbuilderops/tools/webpipe/audit.jsonl")
DEFAULT_MAX_BYTES = 10 * 1024 * 1024  # 10MB per log chunk
DEFAULT_BACKUP_COUNT = 5              # Keep up to 5 rotated backup files

class WebPipeLogger:
    """
    Comprehensive, auditable JSONL logger for WebPipe operations.
    Supports:
    - High-fidelity event logging (page state, auth, wrong-page/404, dom extraction, clicks/keys)
    - Hourly rotation or size-based rolling logs
    - Explicit wipe options (wipe after session, wipe hourly, or purge on demand)
    """

    def __init__(self, log_path=DEFAULT_LOG_PATH, max_bytes=DEFAULT_MAX_BYTES, backup_count=DEFAULT_BACKUP_COUNT):
        self.log_path = os.path.expanduser(log_path)
        self.max_bytes = max_bytes
        self.backup_count = backup_count
        os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
        self._check_rotation()

    def _check_rotation(self):
        """Rotates the log file if it exceeds max_bytes."""
        try:
            if os.path.exists(self.log_path) and os.path.getsize(self.log_path) >= self.max_bytes:
                self.rotate_now()
        except Exception:
            pass

    def rotate_now(self):
        """Forces an immediate rotation of the log file with timestamp."""
        if not os.path.exists(self.log_path):
            return
        ts_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        rotated_path = f"{self.log_path}.{ts_str}.bak"
        try:
            shutil.move(self.log_path, rotated_path)
            # Prune old backups beyond backup_count
            base_dir = os.path.dirname(self.log_path)
            base_name = os.path.basename(self.log_path)
            backups = sorted(glob.glob(os.path.join(base_dir, f"{base_name}.*.bak")))
            if len(backups) > self.backup_count:
                for b in backups[:-self.backup_count]:
                    os.remove(b)
        except Exception:
            pass

    def wipe_session(self):
        """Wipes the active session log clean."""
        if os.path.exists(self.log_path):
            with open(self.log_path, "w", encoding="utf-8") as f:
                f.write("")

    def wipe_all_logs(self):
        """Purges active log and all rotated history."""
        self.wipe_session()
        base_dir = os.path.dirname(self.log_path)
        base_name = os.path.basename(self.log_path)
        for b in glob.glob(os.path.join(base_dir, f"{base_name}.*.bak")):
            try:
                os.remove(b)
            except Exception:
                pass

    def log_event(self, event_type, url, details=None):
        self._check_rotation()
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event_type,
            "url": url,
            "details": details or {}
        }
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        return entry

    def log_request_start(self, url, options=None):
        return self.log_event("REQUEST_START", url, {"options": options or {}})

    def log_page_state(self, url, title, http_status=None, is_signed_in=None, user_identifier=None,
                       auth_barrier=False, is_wrong_page=False, wrong_page_reason=None, actions_taken=None):
        """
        Comprehensive log entry recording exact navigation state, sign-in verification,
        page correctness, and actions taken.
        """
        return self.log_event("PAGE_STATE", url, {
            "title": title,
            "http_status": http_status,
            "is_signed_in": is_signed_in,
            "user_identifier": user_identifier,
            "auth_barrier": auth_barrier,
            "is_wrong_page": is_wrong_page,
            "wrong_page_reason": wrong_page_reason,
            "actions_taken": actions_taken or []
        })

    def log_auth_challenge(self, url, reason):
        return self.log_event("AUTH_CHALLENGE_DETECTED", url, {"reason": reason})

    def log_auth_resolved(self, url, resolution_time_s):
        return self.log_event("AUTH_RESOLVED", url, {"resolution_time_s": resolution_time_s})

    def log_data_extracted(self, url, raw_bytes, clean_bytes, api_payloads_count, duration_ms):
        savings_pct = round((1.0 - (clean_bytes / max(1, raw_bytes))) * 100, 2)
        return self.log_event("DATA_EXTRACTED", url, {
            "raw_bytes": raw_bytes,
            "clean_bytes": clean_bytes,
            "savings_pct": f"{savings_pct}%",
            "api_payloads_captured": api_payloads_count,
            "duration_ms": duration_ms
        })

    def log_action(self, url, action_name, params=None, result=None):
        return self.log_event("ACTION_EXECUTED", url, {
            "action": action_name,
            "params": params or {},
            "result": result
        })

    def log_error(self, url, error_msg, trace=None):
        return self.log_event("ERROR", url, {
            "error": str(error_msg),
            "trace": trace
        })
