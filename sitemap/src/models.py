"""
Pydantic models for the Site Awareness Object.
This is the structured output SiteMap hands to an AI agent.
"""
from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, HttpUrl


class Page(BaseModel):
    """A single discovered page on the site."""
    path: str
    title: str
    summary: str
    content_markdown: str = ""


class Form(BaseModel):
    """A form the AI can fill and submit."""
    page: str
    fields: list[str]
    action: str          # e.g. "POST /api/register"
    method: str = "POST"


class Action(BaseModel):
    """A clickable or callable element the AI can invoke."""
    label: str
    type: Literal["button", "link", "input", "select"]
    leads_to: str | None = None   # path navigated to on click
    endpoint: str | None = None   # API endpoint if known


class Auth(BaseModel):
    required: bool
    method: str | None = None     # e.g. "cookie/JWT", "OAuth"


class SiteAwarenessObject(BaseModel):
    """
    The complete structured map of a website.
    Hand this to an AI agent so it can reason about and interact
    with the site without ever seeing raw HTML.
    """
    url: str
    pages: list[Page] = []
    forms: list[Form] = []
    actions: list[Action] = []
    auth: Auth = Auth(required=False)
    api_hints: list[str] = []

    def get_page(self, path: str) -> Page | None:
        """Look up a page by path."""
        for p in self.pages:
            if p.path == path:
                return p
        return None

    def get_actions_for_page(self, path: str) -> list[Action]:
        """Return all actions available on a given page."""
        return [a for a in self.actions if a.leads_to and path in a.leads_to]
