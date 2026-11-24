"""Method A over all 36 launch items: build the judge packets.

Design (pre-registered in PREREG_Human_vs_LLM.md before any judge runs):
  * all 630 unordered pairs of the 36 items, shuffled with seed 20261124, cut into 5 blocks of 126;
  * each block judged by 6 isolated judges; for every pair, judges 0-2 see one order and 3-5 the other;
  * each judge gets its own random opaque labels (Q01-Q36), all 36 items listed in label order,
    and its 126 pairs in its own random order;
  * forced choice, one reason of 20 words or fewer per pair.
Writes design.json (the label key, kept away from judges) and packets/b{block}_j{judge}.md.
"""
import hashlib, itertools, json, os, random, sys

ITEMS = json.load(open(sys.argv[1]))["items"]
OUT = os.path.dirname(os.path.abspath(__file__))
SEED = 20261124
BLOCKS, JUDGES = 5, 6

CRITERION = ("Which is the better hearing question: the one that more clearly lets a panel separate a strong, "
             "well-prepared team from a weak one, across a 4-minute opening and 6–10 minutes of follow-up?")

INSTRUCTIONS = """# Hearing question judging — packet {token}

You are one of several independent judges. Work only from this packet. Do not open, search for, or read any other
file, and do not use the web.

## The format the questions are written for

In a We the People simulated congressional hearing, a unit of high school students answers one published hearing
question. They give a prepared opening statement of about 4 minutes. A panel of judges then asks follow-up questions
for 6 to 10 minutes and scores the team. Each question has a main prompt (the stem) and two follow-up bullets.

## Your task

For each numbered pair below, answer one question:

> {criterion}

Rules:
1. Pick exactly one question in every pair. No ties. If it is close, pick the one you would choose on balance.
2. Judge each pair on its own. Do not rank the questions first, and do not try to keep your answers consistent by
   bookkeeping across pairs.
3. Ignore which question is listed first.
4. The labels (Q01 to Q36) are random and carry no information.
5. Give a reason of 20 words or fewer for each pick.

## Output

Write a single JSON object to the file `{outpath}` and nothing else into that file:

```json
{{"token": "{token}", "pairs": [{{"n": 1, "first": "Q..", "second": "Q..", "winner": "Q..", "reason": "..."}}, ...]}}
```

Include all {npairs} pairs, in the numbered order, with `first` and `second` exactly as listed. Then reply with one line:
`done {token} {npairs}`.

## The questions

{items}

## The pairs

{pairs}
"""


def item_md(label, it):
    bullets = "\n".join(f"   - {b}" for b in it["bullets"])
    return f"**{label}.** {it['stem']}\n{bullets}\n"


def main():
    rng = random.Random(SEED)
    ids = [it["id"] for it in ITEMS]
    by_id = {it["id"]: it for it in ITEMS}
    pairs = list(itertools.combinations(ids, 2))
    assert len(pairs) == 630
    rng.shuffle(pairs)
    size = len(pairs) // BLOCKS
    os.makedirs(os.path.join(OUT, "packets"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "out"), exist_ok=True)
    design = dict(seed=SEED, criterion=CRITERION, blocks=BLOCKS, judges_per_block=JUDGES, judges=[])
    for b in range(BLOCKS):
        block = pairs[b * size:(b + 1) * size]
        base = [(x, y) if rng.random() < 0.5 else (y, x) for x, y in block]
        for j in range(JUDGES):
            token = f"b{b}j{j}"
            shown = base if j < 3 else [(y, x) for x, y in base]
            order = list(range(len(shown)))
            rng.shuffle(order)
            shown = [shown[k] for k in order]
            perm = ids[:]
            rng.shuffle(perm)
            labels = {f"Q{k + 1:02d}": perm[k] for k in range(len(perm))}
            inv = {v: k for k, v in labels.items()}
            items_md = "\n".join(item_md(lab, by_id[labels[lab]]) for lab in sorted(labels))
            pairs_md = "\n".join(f"{n}. {inv[x]} vs {inv[y]}" for n, (x, y) in enumerate(shown, 1))
            outpath = os.path.join(OUT, "out", f"{token}.json")
            text = INSTRUCTIONS.format(token=token, criterion=CRITERION, outpath=outpath, npairs=len(shown),
                                       items=items_md, pairs=pairs_md)
            ppath = os.path.join(OUT, "packets", f"{token}.md")
            open(ppath, "w").write(text)
            design["judges"].append(dict(token=token, block=b, judge=j, orientation="base" if j < 3 else "reversed",
                                         labels=labels,
                                         pairs=[dict(n=n, first=inv[x], second=inv[y]) for n, (x, y) in enumerate(shown, 1)],
                                         packet_sha256=hashlib.sha256(text.encode()).hexdigest()))
    # Every pair: 6 judgments, 3 in each order.
    seen = {}
    for jd in design["judges"]:
        for p in jd["pairs"]:
            x, y = jd["labels"][p["first"]], jd["labels"][p["second"]]
            seen.setdefault(frozenset((x, y)), []).append((x, y))
    assert len(seen) == 630 and all(len(v) == 6 for v in seen.values())
    assert all(len(set(v)) == 2 and v.count(v[0]) == 3 for v in seen.values())
    raw = json.dumps(design, indent=1).encode()
    open(os.path.join(OUT, "design.json"), "wb").write(raw)
    print("judges", len(design["judges"]), "design sha256", hashlib.sha256(raw).hexdigest())


if __name__ == "__main__":
    main()
