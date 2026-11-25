"""Build one item file per unit and level from items/transcribed.json (owner decision, 25 Nov 2026: rounds of about
35 questions, one per unit and level).

    python3 items/build_round_sets.py

Writes items/rounds/<level>-u<unit>.json in the format the admin loader takes, and items/rounds/index.json. Rerun
after transcribing more PDFs; bump VERSION if a set that is already loaded on the site would change, because a
loaded item set never changes.
"""
import collections
import json
import os

VERSION = 1
HERE = os.path.dirname(os.path.abspath(__file__))
items = json.load(open(os.path.join(HERE, "transcribed.json")))
groups = collections.defaultdict(list)
for it in items:
    groups[(it["level"], it["unit"])].append(it)
os.makedirs(os.path.join(HERE, "rounds"), exist_ok=True)
index = []
for (level, unit), its in sorted(groups.items(), key=lambda kv: (kv[0][0] != "State", kv[0][1])):
    its.sort(key=lambda i: i["id"])
    slug = f"{'state' if level == 'State' else 'nf'}-u{unit}"
    name = f"Unit {unit}, {'State' if level == 'State' else 'National Finals'}"
    cycles = sorted({i["cycle"] for i in its})
    doc = dict(item_set=slug, version=VERSION, round_name=name, level=level, unit=unit, cycles=cycles,
               frame=f"Published CCE {level} hearing questions, Unit {unit}, cycles {cycles[0]} to {cycles[-1]}",
               shown_to_voters=["stem", "bullets"],
               hidden_from_voters=["id", "val_id", "cycle", "unit", "q", "level", "source"],
               items=[{k: i[k] for k in ("id", "val_id", "level", "cycle", "unit", "q", "published", "stem", "bullets", "source", "text_source")} for i in its])
    json.dump(doc, open(os.path.join(HERE, "rounds", slug + ".json"), "w"), ensure_ascii=False, indent=1)
    index.append(dict(file=slug + ".json", item_set=f"{slug}-v{VERSION}", round_name=name, questions=len(its), cycles=f"{cycles[0]} to {cycles[-1]}"))
json.dump(index, open(os.path.join(HERE, "rounds", "index.json"), "w"), indent=1)
for i in index:
    print(i["item_set"], i["round_name"], i["questions"], i["cycles"])
