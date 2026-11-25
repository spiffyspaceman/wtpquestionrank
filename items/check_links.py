"""Check the web addresses in the published footnotes (items/transcribed.json) and record what was found in
items/links.json.

    python3 items/check_links.py            # check every address not yet settled
    python3 items/check_links.py --all      # check them all again

For each address: is the page there, and are the quoted words on it? Statuses:
  ok         the page opened (HTTP 200). "quote_found" says whether words from the question's quotation are on it.
  dead       the site answered that the page is gone (404 or 410), or the domain no longer exists.
  unchecked  no answer could be had from here: the network refused the host, the site turned away an automated
             reader (401, 403, 202, 429), it timed out, or it answered some other way.
A "replacement" is never written by this script. Add one by hand, only after opening the new page and finding the
quoted words on it; the site then shows that address in place of the published one.

The site (src/worker/notes.ts) links an address when it is "ok", shows a "replacement" in place of a dead address,
drops a dead address that has none, and shows an unchecked address as plain text unless its record says "link": true
(the owner's choice, 25 Nov 2026, for sites that refuse automated readers; this script keeps that flag).
"""
import datetime
import html
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "links.json")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
URL = re.compile(r"https?://\S+")


def trim(u):
    # One footnote runs "...road-forward(accessed January 27, 2017)" with no space before the bracket.
    return re.split(r"\(accessed", u)[0].rstrip(".,;)”")


def host_refused(url):
    """True when the network here will not open any connection to this address's host (so nothing can be learned)."""
    host = re.sub(r"^https?://([^/]+).*", r"\1", url)
    p = subprocess.run(["curl", "-sS", "--max-time", "15", "-o", "/dev/null", "-w", "%{http_code}", f"https://{host}/"], capture_output=True, text=True)
    return "CONNECT tunnel failed" in p.stderr


def words(s):
    return re.sub(r"[^a-z0-9 ]+", " ", html.unescape(s).lower().replace("’", "'").replace("'", "")).split()


def quotes_for(item):
    """Quotations in the question (text between curly quotes), longest first."""
    text = " ".join([item["stem"]] + item["bullets"])
    return sorted((q for q in re.findall(r"“([^”]+)”", text) if len(q.split()) >= 4), key=len, reverse=True)


def quote_on_page(page_words, quotes):
    page = " " + " ".join(page_words) + " "
    for q in quotes:
        w = [x for x in words(q.replace("…", " ").replace("[", " ").replace("]", " "))]
        # Any run of six consecutive words from the quotation (fewer for a short one), to allow for ellipses and
        # edition differences.
        n = min(6, len(w))
        for k in range(0, max(1, len(w) - n + 1)):
            if n >= 4 and " " + " ".join(w[k:k + n]) + " " in page:
                return True
    return False


def fetch(url):
    p = subprocess.run(["curl", "-sS", "-L", "--max-time", "30", "-A", UA, "-o", "/tmp/_link_body", "-w", "%{http_code}", url],
                       capture_output=True, text=True)
    code = p.stdout.strip()[-3:]
    err = p.stderr.strip().splitlines()[-1] if p.stderr.strip() else ""
    body = ""
    if code == "200" and os.path.exists("/tmp/_link_body"):
        raw = open("/tmp/_link_body", "rb").read()
        if raw[:4] == b"%PDF":
            body = subprocess.run(["pdftotext", "/tmp/_link_body", "-"], capture_output=True).stdout.decode("utf-8", "replace")
        else:
            body = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw.decode("utf-8", "replace"), flags=re.S | re.I)
            body = re.sub(r"<[^>]+>", " ", body)
    return code, err, body


def main():
    items = json.load(open(os.path.join(HERE, "transcribed.json")))
    links = json.load(open(OUT)) if os.path.exists(OUT) else {}
    by_url = {}
    for it in items:
        for n in it["notes"]:
            for u in URL.findall(n["text"]):
                by_url.setdefault(trim(u), []).append(it)
    today = datetime.date.today().isoformat()
    for url in sorted(by_url):
        old = links.get(url, {})
        if old.get("status") in ("ok", "dead") and "--all" not in sys.argv and "--recheck-dead" not in sys.argv:
            continue
        if old.get("status") == "ok" and "--all" not in sys.argv:
            continue
        code, err, body = fetch(url)
        rec = dict(old, http=code, checked=today, questions=sorted({i["id"] for i in by_url[url]}))
        if code == "200":
            rec["status"] = "ok"
            rec["quote_found"] = quote_on_page(words(body), [q for i in by_url[url] for q in quotes_for(i)])
        elif "CONNECT tunnel failed" in err or (code != "200" and host_refused(url)):
            # A proxy that refuses the host can answer a plain-http request with its own 403 or 404. That says
            # nothing about the page.
            rec["status"] = "unchecked"
            rec["why"] = "the network here refused the host"
        elif code in ("404", "410") or "Could not resolve host" in err:
            rec["status"] = "dead"
        else:
            rec["status"] = "unchecked"
            rec["why"] = ("the network here refused the host" if "CONNECT tunnel failed" in err or code == "000" and not err
                          else f"HTTP {code}" if code != "000" else err[:80])
        links[url] = rec
        print(rec["status"], code, url)
    for url in [u for u in links if u not in by_url]:
        del links[url]
    json.dump(links, open(OUT, "w"), indent=1, sort_keys=True)
    tally = {}
    for r in links.values():
        tally[r["status"]] = tally.get(r["status"], 0) + 1
    print(tally, "| ok with the quotation found:", sum(1 for r in links.values() if r.get("quote_found")))


if __name__ == "__main__":
    main()
