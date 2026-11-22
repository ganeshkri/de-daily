#!/usr/bin/env python3
"""
Builds data/problems.json from the markdown files in content/.

Each problem in a content file looks like:

    ### [sql-001] Title
    level: easy | medium | hard
    tags: comma, separated
    asked: yes            (optional — marks questions from real interviews)

    #### Question
    ...
    #### Answer
    ...
    #### What interviewers look for
    ...
    #### Follow-up
    ...

Add new problems to the markdown files and re-run:  python scripts/build_problems.py
"""
import json
import re
import sys
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"
OUT = ROOT / "data" / "problems.json"

CATEGORIES = [  # file stem, display name
    ("sql", "SQL"),
    ("snowflake", "Snowflake"),
    ("dbt", "dbt"),
    ("airflow", "Airflow"),
    ("python", "Python"),
    ("architecture", "Architecture"),
]
SECTIONS = {
    "question": "question",
    "answer": "answer",
    "what interviewers look for": "lookfor",
    "follow-up": "followup",
}
HEADER_RE = re.compile(r"^### \[([a-z0-9-]+)\]\s+(.+)$")


LIST_RE = re.compile(r"^\s*([-*+]|\d+\.)\s")


def loosen(text: str) -> str:
    """Python-Markdown needs a blank line before a list or table that follows a paragraph.
    Insert one so authors can write lists directly under a sentence."""
    out, in_fence = [], False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_fence = not in_fence
        prev = out[-1] if out else ""
        if not in_fence and prev.strip() and not prev.strip().startswith("```"):
            starts_list = LIST_RE.match(line) and not LIST_RE.match(prev) and not prev.startswith((" ", "\t"))
            starts_table = line.lstrip().startswith("|") and not prev.lstrip().startswith("|")
            if starts_list or starts_table:
                out.append("")
        out.append(line)
    return "\n".join(out)


def md_to_html(text: str) -> str:
    return markdown.markdown(
        loosen(text.strip()),
        extensions=["fenced_code", "tables", "codehilite", "sane_lists"],
        extension_configs={"codehilite": {"guess_lang": False, "css_class": "hl"}},
    )


def parse_file(path: Path, category: str):
    problems, current, section, buf = [], None, None, []

    def flush_section():
        if current is not None and section:
            current[SECTIONS[section]] = md_to_html("\n".join(buf))

    for line in path.read_text(encoding="utf-8").splitlines():
        m = HEADER_RE.match(line)
        if m:
            flush_section()
            current = {"id": m.group(1), "title": m.group(2).strip(), "category": category,
                       "level": "medium", "tags": [], "asked": False}
            problems.append(current)
            section, buf = None, []
            continue
        if current is None:
            continue
        if line.startswith("#### "):
            flush_section()
            name = line[5:].strip().lower()
            if name not in SECTIONS:
                sys.exit(f"{path.name}: unknown section '{line}' in {current['id']}")
            section, buf = name, []
            continue
        if section is None:
            meta = re.match(r"^(level|tags|asked):\s*(.*)$", line.strip())
            if meta:
                key, val = meta.groups()
                if key == "level":
                    current["level"] = val.strip().lower()
                elif key == "tags":
                    current["tags"] = [t.strip() for t in val.split(",") if t.strip()]
                elif key == "asked":
                    current["asked"] = val.strip().lower() in ("yes", "true")
            continue
        buf.append(line)
    flush_section()
    return problems


def daily_sequence(problems):
    """Interleave categories proportionally; within a category keep authored order,
    but pull easy problems slightly earlier so the first weeks ramp up."""
    by_cat = {}
    for p in problems:
        by_cat.setdefault(p["category"], []).append(p)
    rank = {"easy": 0, "medium": 1, "hard": 2}
    for cat, items in by_cat.items():
        # stable sort on a softened difficulty: index + bonus for difficulty
        by_cat[cat] = sorted(items, key=lambda p: items.index(p) + 4 * rank[p["level"]])
    total = len(problems)
    taken = {c: 0 for c in by_cat}
    order = []
    while len(order) < total:
        # pick the category furthest behind its fair share
        best = max((c for c in by_cat if taken[c] < len(by_cat[c])),
                   key=lambda c: (len(by_cat[c]) * (len(order) + 1) / total) - taken[c])
        order.append(by_cat[best][taken[best]]["id"])
        taken[best] += 1
    return order


def main():
    problems = []
    for stem, name in CATEGORIES:
        problems += parse_file(CONTENT / f"{stem}.md", name)

    ids = [p["id"] for p in problems]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        sys.exit(f"duplicate ids: {dupes}")
    for p in problems:
        missing = [k for k in ("question", "answer", "lookfor", "followup") if not p.get(k)]
        if missing:
            sys.exit(f"{p['id']} missing sections: {missing}")
        if p["level"] not in ("easy", "medium", "hard"):
            sys.exit(f"{p['id']} bad level {p['level']}")

    data = {
        "version": 1,
        "categories": [name for _, name in CATEGORIES],
        "count": len(problems),
        "sequence": daily_sequence(problems),
        "problems": problems,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")

    from collections import Counter
    print(f"{len(problems)} problems → {OUT.relative_to(ROOT)}")
    print(" by category:", dict(Counter(p["category"] for p in problems)))
    print(" by level:   ", dict(Counter(p["level"] for p in problems)))
    print(" from real interviews:", sum(p["asked"] for p in problems))


if __name__ == "__main__":
    main()
