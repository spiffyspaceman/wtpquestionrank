"""Rebuild design.json-shaped label keys and out/*.json judge files from MethodA36_Compact_*.jsonl,
so analysis/analyze.ts can read method A without the full packet set. Usage:
  python3 llm-arm/expand_compact.py MethodA36_Compact_2026-11-24.jsonl <outdir>
Writes <outdir>/design.json and <outdir>/out/<token>.json."""
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(os.path.join(dst, "out"), exist_ok=True)
judges = []
for line in open(src):
    if not line.strip(): continue
    j = json.loads(line)
    pairs = [dict(n=n, first=f, second=s) for n, (f, s, _) in enumerate(j["pairs"], 1)]
    judges.append(dict(token=j["token"], block=j["block"], judge=j["judge"], labels=j["labels"], pairs=pairs))
    out = dict(token=j["token"], pairs=[dict(n=n, first=f, second=s, winner=w) for n, (f, s, w) in enumerate(j["pairs"], 1)])
    json.dump(out, open(os.path.join(dst, "out", j["token"] + ".json"), "w"))
json.dump(dict(judges=judges), open(os.path.join(dst, "design.json"), "w"))
print(len(judges), "judges expanded")
