#!/usr/bin/env python3
"""
Collects recent articles from data-engineering newsletters and blogs into data/reading.json.
Stores only title, link, date, source and a short snippet — tapping opens the original article.

Edit FEEDS to add or remove sources. A source that fails today keeps its previous items.
"""
import html
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import feedparser
import requests

FEEDS = [
    # name, homepage, candidate feed URLs (first that works is used)
    ("SeattleDataGuy", "https://seattledataguy.substack.com",
     ["https://seattledataguy.substack.com/feed"]),
    ("Data Engineering Weekly", "https://www.dataengineeringweekly.com",
     ["https://www.dataengineeringweekly.com/feed"]),
    ("DataExpert.io (Zach Wilson)", "https://blog.dataexpert.io",
     ["https://blog.dataexpert.io/feed"]),
    ("Data Engineer Things", "https://dataengineerthings.substack.com",
     ["https://dataengineerthings.substack.com/feed", "https://medium.com/feed/data-engineer-things"]),
    ("Snowflake Builders Blog", "https://medium.com/snowflake",
     ["https://medium.com/feed/snowflake"]),
    ("dbt Developer Blog", "https://docs.getdbt.com/blog",
     ["https://docs.getdbt.com/blog/rss.xml", "https://docs.getdbt.com/blog/atom.xml"]),
    ("Apache Airflow Blog", "https://airflow.apache.org/blog/",
     ["https://airflow.apache.org/blog/index.xml", "https://airflow.apache.org/index.xml"]),
    ("Astronomer Blog", "https://www.astronomer.io/blog",
     ["https://www.astronomer.io/blog/rss.xml", "https://www.astronomer.io/rss.xml"]),
    ("Start Data Engineering", "https://www.startdataengineering.com",
     ["https://www.startdataengineering.com/index.xml", "https://www.startdataengineering.com/post/index.xml"]),
    ("Joe Reis", "https://joereis.substack.com",
     ["https://joereis.substack.com/feed"]),
]

TOPICS = {  # topic: keywords (lower-case, matched in title + snippet)
    "Snowflake": ["snowflake", "snowpark", "snowpipe", "cortex", "coco", "dynamic table"],
    "dbt": ["dbt", "analytics engineer", "semantic layer", "metricflow"],
    "Airflow": ["airflow", "dag", "astronomer", "orchestrat"],
    "SQL": ["sql", "query", "window function", "join"],
    "Python": ["python", "pandas", "polars", "pyspark"],
    "Architecture": ["architecture", "design", "lakehouse", "iceberg", "data model", "modeling",
                     "modelling", "governance", "cost", "pipeline", "streaming", "cdc", "data contract"],
    "AI": [" ai ", "ai-", "llm", "agent", "rag", "genai"],
}

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "reading.json"
KEEP_DAYS = 120
MAX_ITEMS = 300
HEADERS = {"User-Agent": "de-daily personal reader (daily RSS fetch)"}


def clean(text: str, limit: int = 260) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(re.sub(r"\s+", " ", text)).strip()
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


def entry_date(e) -> str | None:
    for key in ("published_parsed", "updated_parsed"):
        t = e.get(key)
        if t:
            return datetime(*t[:6], tzinfo=timezone.utc).isoformat()
    return None


def topics_for(text: str) -> list[str]:
    t = f" {text.lower()} "
    return [name for name, words in TOPICS.items() if any(w in t for w in words)]


def fetch_source(name, home, urls):
    for url in urls:
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            if r.status_code != 200:
                print(f"  {name}: {r.status_code} {url}")
                continue
            feed = feedparser.parse(r.content)
            if not feed.entries:
                print(f"  {name}: no entries at {url}")
                continue
            items = []
            for e in feed.entries[:40]:
                link = e.get("link")
                title = clean(e.get("title", ""), 200)
                if not link or not title:
                    continue
                snippet = clean(e.get("summary", "") or e.get("description", ""))
                items.append({
                    "title": title,
                    "url": link if link.startswith("http") else home.rstrip("/") + "/" + link.lstrip("/"),
                    "source": name,
                    "date": entry_date(e),
                    "snippet": snippet,
                    "topics": topics_for(f"{title} {snippet}"),
                })
            print(f"  {name}: {len(items)} items")
            return items, url
        except requests.RequestException as exc:
            print(f"  {name}: {exc}")
        time.sleep(1)
    return None, None


def main():
    previous = {}
    if OUT.exists():
        for it in json.loads(OUT.read_text()).get("items", []):
            previous.setdefault(it["source"], []).append(it)

    items, sources = [], []
    for name, home, urls in FEEDS:
        got, used = fetch_source(name, home, urls)
        ok = got is not None
        sources.append({"name": name, "home": home, "ok": ok, "feed": used})
        items += got if ok else previous.get(name, [])   # keep yesterday's items on failure

    cutoff = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).isoformat()
    seen, unique = set(), []
    for it in sorted(items, key=lambda x: x["date"] or "", reverse=True):
        if it["url"] in seen or (it["date"] and it["date"] < cutoff):
            continue
        seen.add(it["url"])
        unique.append(it)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "topics": list(TOPICS),
        "sources": sources,
        "items": unique[:MAX_ITEMS],
    }, ensure_ascii=False, indent=1) + "\n")
    print(f"{len(unique[:MAX_ITEMS])} items from {sum(s['ok'] for s in sources)}/{len(sources)} sources")
    if not any(s["ok"] for s in sources):
        sys.exit("all feeds failed")


if __name__ == "__main__":
    main()
