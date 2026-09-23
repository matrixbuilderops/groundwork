import websocket
import json
import time

def send_upwork_screener():
    page_ws_url = "ws://127.0.0.1:9225/devtools/page/7990A3FFE15B2906593EB9030D1A621B"
    ws = websocket.create_connection(page_ws_url, timeout=10)

    # 1. Check editor bounds
    js_editor = """
    (() => {
        const editor = document.querySelector('div.ProseMirror[contenteditable="true"]');
        if (!editor) return null;
        editor.focus();
        const r = editor.getBoundingClientRect();
        return {x: Math.round(r.left + 30), y: Math.round(r.top + 20)};
    })()
    """
    ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": js_editor, "returnByValue": True}}))
    res1 = json.loads(ws.recv())
    coords = res1.get("result", {}).get("result", {}).get("value")
    print("Editor coords:", coords)
    if not coords:
        print("Editor not found!")
        ws.close()
        return

    # Click editor
    ws.send(json.dumps({"id": 2, "method": "Input.dispatchMouseEvent", "params": {"type": "mousePressed", "x": coords["x"], "y": coords["y"], "button": "left", "clickCount": 1}}))
    ws.recv()
    ws.send(json.dumps({"id": 3, "method": "Input.dispatchMouseEvent", "params": {"type": "mouseReleased", "x": coords["x"], "y": coords["y"], "button": "left", "clickCount": 1}}))
    ws.recv()

    time.sleep(0.3)

    # Type answers line by line
    answers = [
        "1. c",
        "2. v",
        "3. b",
        "4. b",
        "5. a, b, c, d, e, f"
    ]

    for i, line in enumerate(answers):
        ws.send(json.dumps({"id": 10 + i, "method": "Input.insertText", "params": {"text": line}}))
        ws.recv()
        if i < len(answers) - 1:
            # Shift+Enter for newline without sending
            ws.send(json.dumps({"id": 30 + i, "method": "Input.dispatchKeyEvent", "params": {"type": "rawKeyDown", "windowsVirtualKeyCode": 13, "unmodifiedText": "\r", "text": "\r", "modifiers": 8}}))
            ws.recv()
            ws.send(json.dumps({"id": 50 + i, "method": "Input.dispatchKeyEvent", "params": {"type": "keyUp", "windowsVirtualKeyCode": 13, "modifiers": 8}}))
            ws.recv()
            time.sleep(0.1)

    time.sleep(1)

    # Check text inside editor
    js_text = "document.querySelector('div.ProseMirror[contenteditable=\"true\"]').innerText"
    ws.send(json.dumps({"id": 100, "method": "Runtime.evaluate", "params": {"expression": js_text, "returnByValue": True}}))
    txt_res = json.loads(ws.recv())
    current_editor_text = txt_res.get("result", {}).get("result", {}).get("value")
    print("Current editor text:\n", current_editor_text)

    # Locate Send button
    js_btn = """
    (() => {
        const sendBtn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label')?.toLowerCase().includes('send') || b.innerText.trim().toLowerCase() === 'send');
        if (!sendBtn) return null;
        const r = sendBtn.getBoundingClientRect();
        return {
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            disabled: sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true'
        };
    })()
    """
    ws.send(json.dumps({"id": 101, "method": "Runtime.evaluate", "params": {"expression": js_btn, "returnByValue": True}}))
    btn_res = json.loads(ws.recv())
    btn_info = btn_res.get("result", {}).get("result", {}).get("value")
    print("Send button status:", btn_info)

    if btn_info and not btn_info.get("disabled"):
        ws.send(json.dumps({"id": 102, "method": "Input.dispatchMouseEvent", "params": {"type": "mousePressed", "x": btn_info["x"], "y": btn_info["y"], "button": "left", "clickCount": 1}}))
        ws.recv()
        ws.send(json.dumps({"id": 103, "method": "Input.dispatchMouseEvent", "params": {"type": "mouseReleased", "x": btn_info["x"], "y": btn_info["y"], "button": "left", "clickCount": 1}}))
        ws.recv()
        print("✅ Clicked Send button successfully!")
    else:
        print("❌ Send button not ready or disabled.")

    time.sleep(2)
    ws.close()

if __name__ == "__main__":
    send_upwork_screener()
