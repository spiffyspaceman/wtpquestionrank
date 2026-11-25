"""Transcribe CCE's published hearing-question PDFs into item records.

    python3 items/transcribe.py <pdf> [<pdf> ...]      # writes items/transcribed.json and prints a report

Same rules as items/build_items.py used for the launch items: PDF line wraps joined with single spaces, footnote
markers and footnote citations removed, every other character kept as published, including the source's own typos.
Nothing is paraphrased, corrected or filled in. A question the parser cannot read cleanly is reported, not guessed.
"""
import hashlib
import json
import os
import re
import subprocess
import sys

UNIT_WORD = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}
BULLET = re.compile(r"^\s*[••●○◦o·▪■-]\s+(?=\S)")
QNUM = re.compile(r"^\s{0,6}([1-9])\.\s+(?=\S)")
STAR = "*\u2217\uff0a\u204e"
FOOT = re.compile(r"^\s*([" + STAR + r"]{1,3}|†|‡|\d{1,2})\s*(?=[A-Z“\"‘(])")
ADDRESS = re.compile(r"Center for Civic Education|www\.civiced\.org|Douglas Fir|Calabasas|civiced\.org|^\s*\d+\s*$|Page \d+", re.I)
TITLE = re.compile(r"HEARING QUESTIONS|NATIONAL FINALS|NATIONAL INVITATIONAL|WE THE PEOPLE", re.I)


def pages(pdf):
    n = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", pdf], capture_output=True, text=True).stdout).group(1))
    for p in range(1, n + 1):
        # Bytes, not text mode: a stray carriage return inside a line must stay white space, not become a line break.
        raw = subprocess.run(["pdftotext", "-layout", "-f", str(p), "-l", str(p), pdf, "-"], capture_output=True).stdout
        yield p, raw.decode("utf-8").replace("\r\n", "\n").replace("\r", " ").replace("\f", "")


def clean(parts):
    s = " ".join(x.strip() for x in parts if x.strip())
    s = re.sub(r"\s+", " ", s).strip()
    # Footnote markers: asterisks or daggers after a word, quote or punctuation mark.
    s = re.sub(r"(?<=[\w”’\"'.,;:?!)\]])\s?([" + STAR + r"]{1,3}|†|‡)(?=[\s.,;:?!)]|$)", "", s)
    return re.sub(r"\s+", " ", s).strip()


def parse(pdf, level, cycle):
    out, notes = [], []
    for pno, text in pages(pdf):
        # Some files carry zero-width spaces after list numbers and bullets; they are layout, not text.
        lines = text.replace("\u200b", "").replace("\ufeff", "").split("\n")
        unit = None
        for ln in lines[:12]:
            m = re.match(r"^\s*Unit\s+(One|Two|Three|Four|Five|Six|[1-6])\b", ln, re.I)
            if m:
                unit = UNIT_WORD.get(m.group(1).lower()) or int(m.group(1))
                break
        if unit is None:
            if text.strip():
                notes.append(f"page {pno}: no unit heading; page skipped ({len(text.strip())} chars)")
            continue
        cur, mode, footnote = None, None, False
        qs = []
        for ln in lines:
            if not ln.strip():
                if mode == "foot":
                    mode = None
                continue
            if ADDRESS.search(ln) or (TITLE.search(ln) and cur is None):
                continue
            m = QNUM.match(ln)
            if m and (cur is None or int(m.group(1)) == cur["q"] + 1):
                cur = dict(q=int(m.group(1)), stem=[ln[m.end():]], bullets=[], footnotes=0)
                qs.append(cur)
                mode = "stem"
                continue
            if cur is None:
                continue
            if BULLET.match(ln):
                cur["bullets"].append([BULLET.sub("", ln)])
                mode = "bullet"
                continue
            if FOOT.match(ln) and mode in ("bullet", None, "foot") and cur["bullets"]:
                mode = "foot"
                cur["footnotes"] += 1
                continue
            if mode == "foot":
                continue
            if mode == "stem":
                cur["stem"].append(ln)
            elif mode == "bullet":
                cur["bullets"][-1].append(ln)
            else:
                notes.append(f"unit {unit} q{cur['q']}: stray line after a blank: {ln.strip()[:70]!r}")
        if [q["q"] for q in qs] != [1, 2, 3]:
            notes.append(f"unit {unit}: found questions {[q['q'] for q in qs]}, expected 1, 2, 3")
        for q in qs:
            stem, bullets = clean(q["stem"]), [clean(b) for b in q["bullets"]]
            if len(bullets) != 2:
                notes.append(f"unit {unit} q{q['q']}: {len(bullets)} bullets")
            if re.search(r"[" + STAR + r"†‡]|https?://|\baccessed\b", stem + " ".join(bullets)):
                notes.append(f"unit {unit} q{q['q']}: a footnote marker or citation may remain")
            prefix = {"State": "st", "NF": "nf"}[level]
            out.append(dict(id=f"{prefix}-{cycle}-u{unit}-q{q['q']}", val_id=None, level=level, cycle=cycle, unit=unit, q=q["q"],
                            published=True, stem=stem, bullets=bullets,
                            source=f"CCE {'State' if level == 'State' else 'National Finals'} Hearing Questions {cycle}, Unit {unit}, Question {q['q']}",
                            text_source=f"{os.path.basename(pdf)} (sha256 {hashlib.sha256(open(pdf, 'rb').read()).hexdigest()[:16]}), page {pno}, pdftotext; footnote markers removed"))
    return out, notes


def classify(pdf):
    name = os.path.basename(pdf).lower()
    m = re.search(r"(20\d\d)-(?:20)?(\d\d)(?!\d)", name)
    level = "NF" if "national" in name else "State" if "state" in name else None
    return level, (f"{m.group(1)}-{m.group(2)}" if m else None)


if __name__ == "__main__":
    items, report = [], []
    for pdf in sorted(sys.argv[1:], key=lambda p: classify(p)[::-1] + (p,)):
        level, cycle = classify(pdf)
        if not level or not cycle:
            report.append(f"{os.path.basename(pdf)}: cannot tell level or cycle from the file name; skipped")
            continue
        got, notes = parse(pdf, level, cycle)
        items += got
        report.append(f"{level} {cycle}: {len(got)} questions" + ("" if not notes else "\n    " + "\n    ".join(notes)))
    json.dump(items, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "transcribed.json"), "w"), ensure_ascii=False, indent=1)
    print("\n".join(report))
    print(f"total {len(items)}")
