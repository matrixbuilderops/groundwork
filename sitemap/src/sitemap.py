"""
SiteMap — the main entry point for AI agents.

Usage:
    from sitemap.src import SiteMap

    awareness = await SiteMap.build("https://example.com")
    # Hand `awareness` to an AI agent — it now knows the full site.
"""
from __future__ import annotations
import asyncio
from .crawler import crawl
from .parser import parse_forms, parse_actions, detect_auth
from .extractor import extract_title, extract_content, extract_api_hints
from .models import SiteAwarenessObject, Page, Auth


class SiteMap:
    """
    Builds a Site Awareness Object for any URL.

    This is designed to be called by an AI agent that needs to understand
    a website before interacting with it. Instead of flooding the AI with
    raw HTML, SiteMap hands back a clean structured object the AI can
    reason over, navigate, and act on.

    The returned SiteAwarenessObject contains:
      - pages:      Every discovered page with title, summary, clean content
      - forms:      Every form with its fields and submit endpoint
      - actions:    Every button, link, and input as a callable action
      - auth:       Whether the site requires authentication
      - api_hints:  API endpoints detected in page scripts/attributes

    Example:
        awareness = await SiteMap.build("https://example.com")
        print(awareness.model_dump_json(indent=2))
    """

    @classmethod
    async def build(
        cls,
        url: str,
        max_pages: int = 50,
    ) -> SiteAwarenessObject:
        """
        Crawl `url` and return a fully populated SiteAwarenessObject.

        Args:
            url:        The website to map.
            max_pages:  How many pages to crawl (default 50).

        Returns:
            SiteAwarenessObject — hand this directly to an AI agent.
        """
        raw_pages = await crawl(url, max_pages=max_pages)

        pages: list[Page] = []
        all_forms = []
        all_actions = []
        all_api_hints: set[str] = set()
        auth_required = False

        for path, html in raw_pages.items():
            title = extract_title(html)
            content = extract_content(html)

            # Summarise: first 300 chars of clean content as a quick summary
            summary = content[:300].strip().replace("\n", " ") if content else ""

            pages.append(Page(
                path=path,
                title=title,
                summary=summary,
                content_markdown=content,
            ))

            all_forms.extend(parse_forms(html, path))
            all_actions.extend(parse_actions(html, url))
            all_api_hints.update(extract_api_hints(html))

            if detect_auth(html):
                auth_required = True

        return SiteAwarenessObject(
            url=url,
            pages=pages,
            forms=all_forms,
            actions=all_actions,
            auth=Auth(required=auth_required),
            api_hints=sorted(all_api_hints),
        )

    @classmethod
    def build_sync(cls, url: str, max_pages: int = 50) -> SiteAwarenessObject:
        """Synchronous wrapper around build() for non-async callers."""
        return asyncio.run(cls.build(url, max_pages=max_pages))
