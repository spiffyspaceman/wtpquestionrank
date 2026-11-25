"""Method A2 (draft addendum, 25 Nov 2026): the registered method A packets with the human arm's guidance added.

Each A2 packet is its method A packet (llm-arm/packets/) with exactly three changes:
  1. a section "What strong hearing questions do", word for word as voters see it on /start (src/web/start.html);
  2. rule 5 lets the judge name up to two of the nine reasons voters can tap (src/worker/reasons.ts), with the
     20-word reason kept;
  3. the output goes to llm-arm/out-a2/ and each pair gains a "reasons" list.
Labels, pairs, pair order and question text are untouched, so design.json (the label key) serves both runs and
analysis/analyze.ts reads the A2 output with --llm-out llm-arm/out-a2.

Writes llm-arm/packets-a2/*.md and llm-arm/design_a2_hashes.json. Runs no judge.

    python3 llm-arm/make_addendum_packets.py
"""
import hashlib
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

GUIDE_HEAD = "## What strong hearing questions do"
GUIDE_LEAD = ("Judges score a team on evidence, understanding and analysis, application, and evaluation. A strong question "
              "gives a well-prepared team room to show all four. It:")
GUIDE_POINTS = [
    "rewards reasoning about constitutional principles, not memorized facts;",
    "invites analysis and interpretation, and allows more than one answer a team could defend;",
    "lets students draw on evidence: founding documents, Supreme Court cases, historical examples;",
    "asks them to apply those principles to new situations, to history or to current issues, and to weigh what follows;",
    "is concise, clear and free of partisan framing.",
]
# Codes and comparative labels, in the order voters see them.
REASONS = [
    ("position", "Forces a clearer position"),
    ("substance", "More constitutional substance"),
    ("source", "Better quote or source"),
    ("followup", "More room for follow-up"),
    ("tradeoffs", "Sharper trade-offs"),
    ("readings", "More competing readings of the Constitution"),
    ("decider", "Sharper question of who should decide"),
    ("connects", "Better rewards connecting ideas"),
    ("current", "Stronger tie to current issues"),
]

OLD_RULE5 = "5. Give a reason of 20 words or fewer for each pick.\n"
NEW_RULE5 = (
    "5. For each pick you may name up to two reasons from this list, by code, saying what the question you picked does\n"
    "   better than the other. Naming none is fine.\n"
    + "".join(f"   - `{code}`: {label}\n" for code, label in REASONS)
    + "6. Also give a reason of 20 words or fewer for each pick, in your own words.\n"
)
OLD_JSON = '"winner": "Q..", "reason": "..."}'
NEW_JSON = '"winner": "Q..", "reasons": ["code", ...], "reason": "..."}'


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


def check_against_site():
    """The guidance and the reasons must be the ones the site shows. Fail loudly if either has drifted."""
    start = norm(re.sub(r"<[^>]+>", " ", open(os.path.join(ROOT, "src/web/start.html")).read()))
    for piece in [GUIDE_HEAD[3:], GUIDE_LEAD, *GUIDE_POINTS]:
        assert norm(piece) in start, f"not on /start: {piece}"
    reasons_ts = open(os.path.join(ROOT, "src/worker/reasons.ts")).read()
    site = re.findall(r'\{ code: "(\w+)", label: "([^"]+)" \}', reasons_ts)
    assert site == REASONS, "reasons differ from src/worker/reasons.ts"


def main():
    check_against_site()
    design = json.load(open(os.path.join(HERE, "design.json")))
    guide = GUIDE_HEAD + "\n\n" + GUIDE_LEAD + "\n\n" + "".join(f"- {p}\n" for p in GUIDE_POINTS) + "\n"
    out_dir = os.path.join(HERE, "packets-a2")
    os.makedirs(out_dir, exist_ok=True)
    hashes = {}
    for jd in design["judges"]:
        token = jd["token"]
        text = open(os.path.join(HERE, "packets", f"{token}.md")).read()
        assert hashlib.sha256(text.encode()).hexdigest() == jd["packet_sha256"], f"{token}: method A packet changed"
        for old, new in [
            ("## Your task\n", guide + "## Your task\n"),
            (OLD_RULE5, NEW_RULE5),
            (f"/llm-arm/out/{token}.json", f"/llm-arm/out-a2/{token}.json"),
            (OLD_JSON, NEW_JSON),
        ]:
            assert text.count(old) == 1, f"{token}: expected one {old!r}"
            text = text.replace(old, new)
        open(os.path.join(out_dir, f"{token}.md"), "w").write(text)
        hashes[token] = hashlib.sha256(text.encode()).hexdigest()
    json.dump(dict(derived_from="design.json", method_a_design_sha256=hashlib.sha256(open(os.path.join(HERE, "design.json"), "rb").read()).hexdigest(),
                   packets=hashes), open(os.path.join(HERE, "design_a2_hashes.json"), "w"), indent=1)
    print(f"wrote {len(hashes)} packets to {out_dir}")


if __name__ == "__main__":
    main()
