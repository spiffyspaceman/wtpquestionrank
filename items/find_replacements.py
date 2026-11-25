"""Look for a working page for each dead footnote link, and record it only if the quoted words are on it.

    python3 items/find_replacements.py [candidates.json]

Candidates come from rules that follow known moves of a site, and from an optional file {dead address: [addresses to
try]} (items/replacement_candidates.json holds pages found by searching on 25 Nov 2026: the same speech, column or
document at its publisher's new address or on a scholarly host). A candidate becomes the "replacement" in items/links.json only when the
page opens and holds words from the question's quotation; otherwise nothing is recorded and the site drops the dead
address from the footnote.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_links as cl  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def rule_candidates(url):
    out = []
    # The Center for the Study of the American Constitution moved its files from site 281 to site 1026.
    if "csac.history.wisc.edu" in url and "/sites/281/" in url:
        out.append(url.replace("/sites/281/", "/sites/1026/"))
    if url.startswith("http://"):
        out.append("https://" + url[len("http://"):])
    return out


def main():
    links = json.load(open(cl.OUT))
    items = {i["id"]: i for i in json.load(open(os.path.join(HERE, "transcribed.json")))}
    extra = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else {}
    found = 0
    for url, rec in sorted(links.items()):
        if rec["status"] != "dead" or rec.get("replacement"):
            continue
        quotes = [q for i in rec["questions"] for q in cl.quotes_for(items[i])]
        for cand in rule_candidates(url) + list(extra.get(url, [])):
            code, err, body = cl.fetch(cand)
            has = code == "200" and cl.quote_on_page(cl.words(body), quotes)
            # The same file on the same site, moved to the site's new folder, is the published source itself. It is
            # accepted when it opens even if its words cannot be read by machine (a scanned page, or a question that
            # paraphrases); the note says so.
            # (Not so for a bare switch to https: a lapsed domain can answer over https with someone else's page.)
            same_file = code == "200" and cand in rule_candidates(url) and "/sites/1026/" in cand
            # A candidate from the file may carry what a reader saw on the page (its title and date) when the question
            # quotes nothing to match; it is then accepted if the page opens, and the note records what was seen.
            seen = code == "200" and isinstance(extra.get(url), dict) and extra[url].get(cand)
            if seen and not has:
                rec["replacement"] = cand
                rec["replacement_checked"] = rec["checked"]
                rec["replacement_note"] = "opened; identified by reading the page: " + seen
                found += 1
                print("replaced", url, "->", cand, "(read)")
                break
            if has or same_file:
                rec["replacement"] = cand
                rec["replacement_checked"] = rec["checked"]
                rec["replacement_note"] = ("opened; the quoted words are on the page" if has
                                           else "opened; the same file at the site's new address; the quoted words could not be matched by machine")
                found += 1
                print("replaced", url, "->", cand, "" if has else "(same file, words not matched)")
                break
        else:
            print("none    ", url)
    json.dump(links, open(cl.OUT, "w"), indent=1, sort_keys=True)
    dead = [r for r in links.values() if r["status"] == "dead"]
    print(f"dead {len(dead)}; with a checked replacement {sum(1 for r in dead if r.get('replacement'))}; found this run {found}")


if __name__ == "__main__":
    main()
