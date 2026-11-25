"""Build the item file for the single round that holds every published question (owner decision, 25 Nov 2026:
one round, on Workers Paid) from items/transcribed.json.

    python3 items/build_round_sets.py

Writes items/rounds/all.json in the format the admin loader takes, and items/rounds/index.json. Rerun after
transcribing more PDFs. Bump VERSION only if the set is already loaded on the site, because a loaded item set never
changes; until then the file is simply rebuilt.
"""
import collections
import json
import os

VERSION = 1
HERE = os.path.dirname(os.path.abspath(__file__))
items = sorted(json.load(open(os.path.join(HERE, "transcribed.json"))), key=lambda i: i["id"])
os.makedirs(os.path.join(HERE, "rounds"), exist_ok=True)
by_level = collections.defaultdict(set)
for it in items:
    by_level[it["level"]].add(it["cycle"])
cover = {lv: sorted(c) for lv, c in sorted(by_level.items())}
doc = dict(item_set="all-questions", version=VERSION, round_name="All questions",
           frame="Published CCE hearing questions: " + "; ".join(f"{lv} {c[0]} to {c[-1]} ({len(c)} cycles)" for lv, c in cover.items()),
           cycles=cover, shown_to_voters=["stem", "bullets"],
           hidden_from_voters=["id", "val_id", "cycle", "unit", "q", "level", "source"],
           items=[{k: i[k] for k in ("id", "val_id", "level", "cycle", "unit", "q", "published", "stem", "bullets", "source", "text_source")} for i in items])
json.dump(doc, open(os.path.join(HERE, "rounds", "all.json"), "w"), ensure_ascii=False, indent=1)
index = [dict(file="all.json", item_set=f"all-questions-v{VERSION}", round_name="All questions", questions=len(items), frame=doc["frame"])]
json.dump(index, open(os.path.join(HERE, "rounds", "index.json"), "w"), indent=1)
print(index[0]["item_set"], index[0]["questions"], doc["frame"])
