"""Fetch Google Scholar citation counts for the hibe lab P.I. via SerpApi
and write them to data/citations.json, which the site reads at build time.

Runs once a day from .github/workflows/scholar-sync.yml.
Needs the repository secret SERPAPI_KEY.
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

AUTHOR_ID = "cXEf9b4AAAAJ"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "citations.json")


def norm(title: str) -> str:
    """Lowercase, letters and digits only, so site titles match Scholar titles."""
    return re.sub(r"[^a-z0-9]+", "", title.lower())


def fetch(api_key: str) -> dict:
    params = {
        "engine": "google_scholar_author",
        "author_id": AUTHOR_ID,
        "hl": "en",
        "num": "100",
        "api_key": api_key,
    }
    url = "https://serpapi.com/search.json?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def main() -> int:
    key = os.environ.get("SERPAPI_KEY")
    if not key:
        print("SERPAPI_KEY is not set", file=sys.stderr)
        return 1
    data = fetch(key)
    if "error" in data:
        # Keep yesterday's numbers rather than writing empty ones.
        print("SerpApi error:", data["error"], file=sys.stderr)
        return 1

    table = {k: v for row in data.get("cited_by", {}).get("table", []) for k, v in row.items()}
    articles = [
        {
            "title": a.get("title", ""),
            "key": norm(a.get("title", "")),
            "year": a.get("year", ""),
            "cites": (a.get("cited_by") or {}).get("value") or 0,
        }
        for a in data.get("articles", [])
    ]
    out = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "source": "Google Scholar (via SerpApi)",
        "total": table.get("citations", {}).get("all"),
        "h_index": table.get("h_index", {}).get("all"),
        "i10_index": table.get("i10_index", {}).get("all"),
        "articles": articles,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"wrote {len(articles)} articles, total={out['total']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
