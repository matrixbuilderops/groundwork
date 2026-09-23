"""
One URL normalization, shared by the wire layer and the verification layer.

These two compare the same URLs for the same purpose (did we land where we
asked?), so a second copy that drifts would make them disagree about what
counts as a mismatch.
"""

import re


def norm_url(u):
    """Scheme-, www- and trailing-slash-insensitive. A protocol upgrade or a
    www prefix is not a different destination."""
    u = (u or "").split("#")[0].rstrip("/").lower()
    u = re.sub(r"^https?://", "", u)
    return re.sub(r"^www\.", "", u)
