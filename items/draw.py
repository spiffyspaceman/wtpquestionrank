"""Draw the 24 launch items added to the 12 validation items.
Frame: published State questions in WTP_Scored_Corpus.csv, cycles 2015-16 through 2024-25,
minus the 12 validation items. Four per unit, seed 1124, sorted frame, random.Random.sample."""
import csv, random, sys
VAL = {("2024-25",1,1),("2020-21",1,3),("2018-19",2,3),("2021-22",2,1),("2023-24",3,2),("2021-22",3,1),
       ("2022-23",4,1),("2024-25",4,3),("2017-18",5,2),("2023-24",5,3),("2016-17",6,1),("2023-24",6,2)}
rows = [r for r in csv.DictReader(open(sys.argv[1])) if r["level"]=="State" and r["year"] < "2025-26"]
rng = random.Random(1124)
out = []
for u in range(1,7):
    frame = sorted((r["year"],int(r["unit"]),int(r["qnum"])) for r in rows if int(r["unit"])==u)
    frame = [k for k in frame if k not in VAL]
    out += sorted(rng.sample(frame, 4))
for k in out: print(*k)
print(len(rows), "rows in frame before exclusions")
