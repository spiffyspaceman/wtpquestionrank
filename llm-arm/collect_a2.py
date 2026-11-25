"""Method A2: check the judges' output files against the design, copy them into the repo, write the records file.

    python3 llm-arm/collect_a2.py [source dir, default /home/claude/wtpqr/llm-arm/out-a2]

Checks, per judge: valid JSON, the right token, all 126 pairs in the listed order with `first` and `second` as issued,
a winner that is one of the two, at most two reasons, every reason one of the nine codes. Computes no rating and
compares nothing with any human vote. Writes llm-arm/out-a2/*.json and llm-arm/MethodA2_Records_2026-11-25.jsonl only
when every present file passes; missing judges are listed.
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else "/home/claude/wtpqr/llm-arm/out-a2"
CODES = {"position", "substance", "source", "followup", "tradeoffs", "readings", "decider", "connects", "current"}
MODEL = "claude-opus-5-5"
AGENT = "isolated general-purpose subagent, model requested as 'opus', default effort, run 2026-11-25"

design = json.load(open(os.path.join(HERE, "design.json")))
hashes = json.load(open(os.path.join(HERE, "design_a2_hashes.json")))["packets"]
problems, missing, records = [], [], []
for jd in design["judges"]:
    t = jd["token"]
    f = os.path.join(SRC, f"{t}.json")
    if not os.path.exists(f):
        missing.append(t)
        continue
    try:
        rec = json.load(open(f))
    except Exception as e:  # noqa: BLE001
        problems.append(f"{t}: not valid JSON ({e})")
        continue
    pairs = rec.get("pairs")
    if rec.get("token") != t or not isinstance(pairs, list) or len(pairs) != len(jd["pairs"]):
        problems.append(f"{t}: wrong token or {len(pairs) if isinstance(pairs, list) else 'no'} pairs")
        continue
    out = []
    for want, got in zip(jd["pairs"], pairs):
        rs = got.get("reasons", [])
        ok = (got.get("n") == want["n"] and got.get("first") == want["first"] and got.get("second") == want["second"]
              and got.get("winner") in (want["first"], want["second"])
              and isinstance(rs, list) and len(rs) <= 2 and len(set(rs)) == len(rs) and all(r in CODES for r in rs)
              and isinstance(got.get("reason"), str))
        if not ok:
            problems.append(f"{t} pair {want['n']}: {json.dumps(got)[:160]}")
            continue
        lab = jd["labels"]
        out.append(dict(n=want["n"], first=got["first"], second=got["second"], winner=got["winner"],
                        first_id=lab[got["first"]], second_id=lab[got["second"]], winner_id=lab[got["winner"]],
                        reasons=rs, reason=got["reason"], reason_words=len(got["reason"].split())))
    records.append(dict(token=t, block=jd["block"], judge=jd["judge"], orientation=jd["orientation"], model=MODEL, agent=AGENT,
                        packet_sha256=hashes[t], pairs=out))

print(f"present {len(design['judges']) - len(missing)} of {len(design['judges'])}; missing: {' '.join(missing) or 'none'}")
print(f"problems: {len(problems)}")
for p in problems[:40]:
    print("  " + p)
if problems or missing:
    sys.exit(1)
os.makedirs(os.path.join(HERE, "out-a2"), exist_ok=True)
for jd in design["judges"]:
    t = jd["token"]
    open(os.path.join(HERE, "out-a2", f"{t}.json"), "w").write(open(os.path.join(SRC, f"{t}.json")).read())
path = os.path.join(HERE, "MethodA2_Records_2026-11-25.jsonl")
open(path, "w").write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records))
n = sum(len(r["pairs"]) for r in records)
over = sum(1 for r in records for p in r["pairs"] if p["reason_words"] > 20)
named = sum(1 for r in records for p in r["pairs"] if p["reasons"])
first = sum(1 for r in records for p in r["pairs"] if p["winner"] == p["first"])
print(f"judgments {n}; picks of the first-listed question {first} ({first / n:.1%}); with a named reason {named}; own-words reasons over 20 words {over}")
print("records sha256", hashlib.sha256(open(path, "rb").read()).hexdigest())
