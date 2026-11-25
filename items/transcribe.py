"""Transcribe CCE's published hearing-question PDFs into item records.

    python3 items/transcribe.py <file> [<file> ...]    # writes items/transcribed.json and prints a report

Takes CCE's PDFs and the owner's plain-text extracts of them (.md, one "---" between pages). Where both exist for a
cycle the PDF is the source and the extract is only compared with it; a difference is reported.

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
TITLE = re.compile(r"HEARING QUESTIONS|NATIONAL FINALS|NATIONAL INVITATIONAL|WE THE PEOPLE|ACADEMIC YEAR|^\s*\*Source:", re.I)


def pages(pdf):
    if pdf.endswith(".md"):
        # A plain-text extract: pages are separated by a line of three hyphens.
        for p, text in enumerate(re.split(r"(?m)^---\s*$", open(pdf, encoding="utf-8").read()), 0):
            yield p, text
        return
    n = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", pdf], capture_output=True, text=True).stdout).group(1))
    for p in range(1, n + 1):
        # Bytes, not text mode: a stray carriage return inside a line must stay white space, not become a line break.
        raw = subprocess.run(["pdftotext", "-layout", "-f", str(p), "-l", str(p), pdf, "-"], capture_output=True).stdout
        yield p, raw.decode("utf-8").replace("\r\n", "\n").replace("\r", " ").replace("\f", "")


def clean(parts):
    # A compound word broken after its hyphen at the end of a line ("Anti-" / "Federalists") is joined without a
    # space. A hanging hyphen before "and" or "or" ("civil- and political") keeps its space. The owner's text extracts
    # mark the same break with a control character; that becomes the hyphen it stands for.
    s = ""
    for x in (y.strip().replace("\x02", "-") for y in parts if y.strip()):
        glue = "" if re.search(r"\w-$", s) and not re.match(r"(and|or)\b", x) else " "
        s = x if not s else s + glue + x
    s = re.sub(r"\s+", " ", s).strip()
    # Footnote markers: asterisks or daggers after a word, quote or punctuation mark.
    s = re.sub(r"(?<=[\w”’\"'.,;:?!)\]])\s?([" + STAR + r"]{1,3}|†|‡)(?=[\s.,;:?!)]|$)", "", s)
    return re.sub(r"\s+", " ", s).strip()


FURNITURE = re.compile(r"Unit continues on the next page|^\s*Page \d+ of \d+\s*$|^\s*>\s*\*\*Extraction note", re.I)
UNIT = re.compile(r"^\s*Unit\s+(One|Two|Three|Four|Five|Six|[1-6])\s*:", re.I)


def parse(pdf, level, cycle):
    """One pass over the whole file. A unit, and a question, may run over a page break."""
    notes = []
    # A PDF read with its layout puts a blank line after a footnote. An extract has no blank lines, so there a
    # footnote runs until the next question, bullet or page.
    flat = pdf.endswith(".md")
    units = {}  # unit -> list of questions, in order
    unit, cur, mode, heading = None, None, None, False
    for pno, text in pages(pdf):
        # Some files carry zero-width spaces after list numbers and bullets; they are layout, not text.
        lines = text.replace("\u200b", "").replace("\ufeff", "").split("\n")
        if mode == "foot":
            mode = "bullet" if cur and cur["bullets"] else "stem"  # a footnote never crosses a page
        for ln in lines:
            if not ln.strip():
                if mode == "foot" and not flat:
                    mode = None
                heading = False
                continue
            if ADDRESS.search(ln) or FURNITURE.search(ln) or (TITLE.search(ln) and len(ln.strip()) < 80):
                continue
            m = UNIT.match(ln)
            if m:
                u = UNIT_WORD.get(m.group(1).lower()) or int(m.group(1))
                if u != unit:
                    unit, cur, mode = u, None, None
                    units.setdefault(u, [])
                heading = True  # the unit title may wrap onto the next line
                continue
            if unit is None:
                continue
            m = QNUM.match(ln)
            if m and int(m.group(1)) == len(units[unit]) + 1:
                cur = dict(q=int(m.group(1)), stem=[ln[m.end():]], bullets=[], page=pno)
                units[unit].append(cur)
                mode, heading = "stem", False
                continue
            if cur is None:
                if not heading:
                    notes.append(f"unit {unit}: text before question 1: {ln.strip()[:60]!r}")
                continue
            if heading:
                continue  # the wrapped end of a repeated unit title on a continuation page
            if BULLET.match(ln):
                if mode == "foot" and flat:
                    notes.append(f"unit {unit} q{cur['q']}: a bullet follows a footnote; check this question by eye")
                cur["bullets"].append([BULLET.sub("", ln)])
                mode = "bullet"
                continue
            if FOOT.match(ln) and mode in ("bullet", None, "foot") and cur["bullets"]:
                mode = "foot"
                continue
            if mode == "foot":
                continue
            if mode == "stem":
                cur["stem"].append(ln)
            elif mode == "bullet":
                cur["bullets"][-1].append(ln)
            else:
                notes.append(f"unit {unit} q{cur['q']}: stray line after a blank: {ln.strip()[:70]!r}")
    out = []
    if sorted(units) != [1, 2, 3, 4, 5, 6]:
        notes.append(f"found units {sorted(units)}, expected 1 to 6")
    for unit in sorted(units):
        qs = units[unit]
        if [q["q"] for q in qs] not in ([1, 2, 3], [1, 2]):
            notes.append(f"unit {unit}: found questions {[q['q'] for q in qs]}, expected 1, 2, 3 (or 1, 2)")
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
                            text_source=f"{os.path.basename(pdf)} (sha256 {hashlib.sha256(open(pdf, 'rb').read()).hexdigest()[:16]}), "
                                        + (f"page {q['page']}, pdftotext" if not flat else "the owner's text extract of CCE's PDF")
                                        + "; footnote markers removed"))
    return out, notes


def classify(pdf):
    name = os.path.basename(pdf).lower()
    m = re.search(r"(20\d\d)-?(?:20)?(\d\d)(?!\d)", name)
    level = "NF" if "national" in name or name.startswith("nf_") else "State" if "state" in name else None
    return level, (f"{m.group(1)}-{m.group(2)}" if m else None)


if __name__ == "__main__":
    by_cycle, report = {}, []
    for f in sys.argv[1:]:
        level, cycle = classify(f)
        if not level or not cycle:
            report.append(f"{os.path.basename(f)}: cannot tell level or cycle from the file name; skipped")
            continue
        by_cycle.setdefault((cycle, level), []).append(f)
    items = []
    for (cycle, level), files in sorted(by_cycle.items()):
        pdfs = [f for f in files if not f.endswith(".md")]
        mds = [f for f in files if f.endswith(".md")]
        got, notes = parse((pdfs or mds)[0], level, cycle)
        line = f"{level} {cycle}: {len(got)} questions from {'the PDF' if pdfs else 'the text extract'}"
        if len(pdfs) > 1:
            other, _ = parse(pdfs[1], level, cycle)
            same = [(x["stem"], x["bullets"]) for x in other] == [(x["stem"], x["bullets"]) for x in got]
            line += "; a second PDF " + ("agrees" if same else "DIFFERS")
        if pdfs and mds:
            other, onotes = parse(mds[0], level, cycle)
            a = {x["id"]: (x["stem"], x["bullets"]) for x in got}
            b = {x["id"]: (x["stem"], x["bullets"]) for x in other}
            diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
            line += "; the text extract " + ("agrees" if not diff else f"DIFFERS on {len(diff)}: {' '.join(diff[:8])}")
        items += got
        report.append(line + ("" if not notes else "\n    " + "\n    ".join(notes)))
    # Corrections made by eye (items/corrections.json): each names a question, the exact text the extraction produced
    # and what the printed page says. A correction that no longer matches exactly once stops the run.
    here = os.path.dirname(os.path.abspath(__file__))
    fixes = json.load(open(os.path.join(here, "corrections.json")))
    by_id = {i["id"]: i for i in items}
    for fx in fixes:
        it = by_id.get(fx["id"])
        if not it:
            continue
        parts = [it["stem"]] + it["bullets"]
        hits = [k for k, part in enumerate(parts) if fx["find"] in part]
        if len(hits) != 1 or parts[hits[0]].count(fx["find"]) != 1:
            sys.exit(f"correction for {fx['id']} does not match exactly once: {fx['find']!r}")
        fixed = parts[hits[0]].replace(fx["find"], fx["replace"])
        if hits[0] == 0:
            it["stem"] = fixed
        else:
            it["bullets"][hits[0] - 1] = fixed
        if "corrected by eye" not in it["text_source"]:
            it["text_source"] += "; corrected by eye against the page image (items/corrections.json)"
    report.append(f"corrections applied: {sum(1 for fx in fixes if fx['id'] in by_id)}")
    json.dump(items, open(os.path.join(here, "transcribed.json"), "w"), ensure_ascii=False, indent=1)
    print("\n".join(report))
    print(f"total {len(items)}")
