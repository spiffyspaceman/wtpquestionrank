"""Exercise the D1 schema in local SQLite: constraints, append-only triggers, one-vote-per-pair."""
import sqlite3, sys
db = sqlite3.connect(":memory:")
db.executescript(open(sys.argv[1]).read())
now = "2026-11-24T00:00:00Z"
x = db.execute
def fails(sql, args=()):
    try:
        x(sql, args); return False
    except sqlite3.DatabaseError as e:
        return str(e)
# draft question rejected
assert fails("INSERT INTO questions VALUES ('d','State','2026-27',1,1,0,'s','[]','src',NULL,'h',NULL,?)", (now,))
for q in ("a", "b", "c"):
    x("INSERT INTO questions VALUES (?,'State','2021-22',1,1,1,'stem','[]','src',NULL,'h',NULL,?)", (q, now))
x("INSERT INTO item_sets VALUES ('s1','set',1,'full_text','h',?,NULL)", (now,))
for q in ("a", "b"): x("INSERT INTO item_set_items VALUES ('s1',?)", (q,))
x("UPDATE item_sets SET frozen_at=? WHERE id='s1'", (now,))
assert "frozen" in fails("INSERT INTO item_set_items VALUES ('s1','c')")
assert "immutable" in fails("UPDATE questions SET stem='x' WHERE id='a'")
x("INSERT INTO rounds VALUES ('r1','R1','s1','open',?,?,NULL,NULL)", (now, now))
assert fails("INSERT INTO rounds VALUES ('r2','R2','s1','open',?,?,NULL,NULL)", (now, now)), "two open rounds"
assert fails("INSERT INTO voters VALUES ('v0','h0','parent','P 01',0,?,NULL,NULL)", (now,)), "bad role"
x("INSERT INTO voters VALUES ('v1','h1','judge','Judge 01',0,?,NULL,NULL)", (now,))
x("INSERT INTO batches VALUES ('b1','r1','v1',7,?)", (now,))
for i, (l, r, rep) in enumerate([("a","b",0),("b","a",1),("a","b",0)]):
    x("INSERT INTO batch_pairs VALUES (?,?,?,?,?,?,?,?)", (f"p{i}", "b1", i, l, r, rep, "repeat" if rep else "info", now))
ins = "INSERT INTO votes (batch_pair_id,round_id,item_set_id,voter_id,role,left_q,right_q,item_lo,item_hi,winner_q,close_call,is_repeat,after_board,client_ms,server_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
x(ins, ("p0","r1","s1","v1","judge","a","b","a","b","a",0,0,0,30000,31000,now))
x(ins, ("p1","r1","s1","v1","judge","b","a","a","b","b",1,1,0,25000,26000,now))  # swapped repeat allowed
assert "UNIQUE" in fails(ins, ("p2","r1","s1","v1","judge","a","b","a","b","b",0,0,0,1,1,now)), "second first-presentation vote"
assert fails(ins, ("p2","r1","s1","v1","judge","a","b","b","a","a",0,0,0,1,1,now)), "lo/hi order"
assert fails(ins, ("p2","r1","s1","v1","judge","a","b","a","b","c",0,0,0,1,1,now)), "winner not shown"
assert "append-only" in fails("UPDATE votes SET winner_q='b' WHERE id=1")
assert "append-only" in fails("DELETE FROM votes")
x("INSERT INTO admin_audit (at,actor,action,detail_json) VALUES (?,?,?,?)", (now,"sub-123","open_round","{}"))
assert "append-only" in fails("DELETE FROM admin_audit")
print("schema checks passed;", x("SELECT count(*) FROM votes").fetchone()[0], "votes in test log")
