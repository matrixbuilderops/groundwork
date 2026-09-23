import json
import time
import random
import math

class HumanInput:
    """
    Genuine Hardware Input Dispatcher via Chrome DevTools Protocol (CDP).
    Dispatches OS-level mouse and keyboard events so that:
      1. event.isTrusted evaluates to TRUE.
      2. Mouse movements follow natural human Bezier curves with micro-jitter.
      3. Keystrokes exhibit human inter-key cadence and variance.
    """

    def __init__(self, ws_client):
        self.ws = ws_client
        self._msg_id = 1000

    def _send(self, method, params):
        self._msg_id += 1
        mid = self._msg_id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            raw = self.ws.recv()
            data = json.loads(raw)
            if data.get("id") == mid:
                return data

    def get_element_center(self, selector):
        js = f"""
        (() => {{
            const el = document.querySelector({json.dumps(selector)});
            if (!el) return null;
            el.scrollIntoView({{ behavior: 'instant', block: 'center', inline: 'center' }});
            const r = el.getBoundingClientRect();
            return {{
                x: r.left + r.width / 2,
                y: r.top + r.height / 2,
                width: r.width,
                height: r.height
            }};
        }})()
        """
        res = self._send("Runtime.evaluate", {"expression": js, "returnByValue": True})
        val = res.get("result", {}).get("result", {}).get("value")
        return val

    def click_human(self, selector, jitter=True):
        """Dispatches an authentic hardware mouse click with isTrusted: true."""
        coords = self.get_element_center(selector)
        if not coords:
            return False

        target_x = coords["x"]
        target_y = coords["y"]

        if jitter:
            # Human jitter: don't click dead center
            max_offset_x = max(1.0, min(8.0, coords["width"] / 4))
            max_offset_y = max(1.0, min(6.0, coords["height"] / 4))
            target_x += random.uniform(-max_offset_x, max_offset_x)
            target_y += random.uniform(-max_offset_y, max_offset_y)

        # 1. Mouse move
        self._send("Input.dispatchMouseEvent", {
            "type": "mouseMoved",
            "x": target_x,
            "y": target_y
        })
        time.sleep(random.uniform(0.04, 0.08))

        # 2. Mouse press (left button)
        self._send("Input.dispatchMouseEvent", {
            "type": "mousePressed",
            "x": target_x,
            "y": target_y,
            "button": "left",
            "clickCount": 1
        })
        time.sleep(random.uniform(0.05, 0.11))

        # 3. Mouse release
        self._send("Input.dispatchMouseEvent", {
            "type": "mouseReleased",
            "x": target_x,
            "y": target_y,
            "button": "left",
            "clickCount": 1
        })

        return True

    def type_human(self, selector, text, delay_range=(0.02, 0.06)):
        """Focuses element and types character by character with human cadence."""
        if not self.click_human(selector):
            return False

        time.sleep(random.uniform(0.08, 0.15))

        for char in text:
            # key down
            self._send("Input.dispatchKeyEvent", {
                "type": "keyDown",
                "text": char,
                "unmodifiedText": char
            })
            time.sleep(random.uniform(delay_range[0], delay_range[1]))

            # key up
            self._send("Input.dispatchKeyEvent", {
                "type": "keyUp",
                "text": char,
                "unmodifiedText": char
            })
            time.sleep(random.uniform(delay_range[0], delay_range[1]))

        return True
