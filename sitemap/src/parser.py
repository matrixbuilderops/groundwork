"""
DOM parser — extracts interactive elements (forms, buttons, links, inputs)
from raw HTML using BeautifulSoup.
"""
from __future__ import annotations
from bs4 import BeautifulSoup
from .models import Form, Action


def parse_forms(html: str, page_path: str) -> list[Form]:
    """
    Extract all forms from a page and return them as Form objects
    the AI can use to understand what data the site accepts.
    """
    soup = BeautifulSoup(html, "html.parser")
    forms: list[Form] = []

    for form in soup.find_all("form"):
        fields = []
        for inp in form.find_all(["input", "textarea", "select"]):
            name = inp.get("name") or inp.get("id") or inp.get("placeholder", "")
            if name and inp.get("type") != "hidden":
                fields.append(name)

        action = form.get("action", page_path)
        method = (form.get("method") or "GET").upper()

        if fields:
            forms.append(Form(
                page=page_path,
                fields=fields,
                action=f"{method} {action}",
                method=method,
            ))

    return forms


def parse_actions(html: str, base_url: str) -> list[Action]:
    """
    Extract all interactive elements (buttons, links, inputs) and
    return them as Action objects the AI can call.
    """
    soup = BeautifulSoup(html, "html.parser")
    actions: list[Action] = []
    seen: set[str] = set()

    # Buttons
    for btn in soup.find_all("button"):
        label = btn.get_text(strip=True)
        if label and label not in seen:
            seen.add(label)
            actions.append(Action(
                label=label,
                type="button",
                leads_to=btn.get("data-href") or btn.get("formaction"),
            ))

    # Links (anchor tags with meaningful text)
    for a in soup.find_all("a", href=True):
        label = a.get_text(strip=True)
        href = a["href"]
        if label and href and not href.startswith(("mailto:", "javascript:", "#")):
            key = f"{label}:{href}"
            if key not in seen:
                seen.add(key)
                actions.append(Action(
                    label=label,
                    type="link",
                    leads_to=href,
                ))

    # Search / text inputs outside forms
    for inp in soup.find_all("input", type=["search", "text"]):
        label = inp.get("placeholder") or inp.get("name") or inp.get("id", "")
        if label and label not in seen:
            seen.add(label)
            form = inp.find_parent("form")
            endpoint = None
            if form:
                action = form.get("action", "")
                name = inp.get("name", "q")
                endpoint = f"{action}?{name}="
            actions.append(Action(
                label=label,
                type="input",
                endpoint=endpoint,
            ))

    return actions


def detect_auth(html: str) -> bool:
    """Heuristic: does the page look like it requires authentication?"""
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text().lower()
    signals = ["log in", "login", "sign in", "signin", "please authenticate", "unauthorized"]
    return any(s in text for s in signals)
