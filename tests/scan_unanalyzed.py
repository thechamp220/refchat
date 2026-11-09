import json
import sys
import collections
from pathlib import Path

HOME = Path.home()
files = [Path(a) for a in sys.argv[1:]] or [
    HOME / "RefchatArchive" / "2026" / "2026-09-09.jsonl",
    HOME / "RefchatArchive" / "2026" / "2026-09-10.jsonl",
    HOME / "Downloads" / "csg-moderation-2026-09-08.jsonl",
    HOME / "Downloads" / "csg-moderation-2026-09-11.jsonl",
]


def scan(path):
    labels = collections.Counter()
    sources = collections.Counter()
    reviewed = collections.Counter()
    pending = []
    dropped = []
    empty = []
    n = 0
    keys = None
    sample = None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if not isinstance(r, dict):
                continue
            n += 1
            if keys is None:
                keys = list(r.keys())
                sample = r
            lab = str(r.get("label") or "").lower()
            src = str(r.get("source") or "")
            rev = int(r.get("reviewed") or 0)
            labels[lab or "(empty)"] += 1
            sources[src or "(empty)"] += 1
            reviewed[rev] += 1
            if lab == "pending":
                pending.append(r)
            elif lab == "dropped":
                dropped.append(r)
            elif not lab:
                empty.append(r)
    return {
        "n": n,
        "keys": keys,
        "labels": labels,
        "sources": sources,
        "reviewed": reviewed,
        "pending": pending,
        "dropped": dropped,
        "empty": empty,
        "sample": sample,
    }


for p in files:
    if not p.exists():
        print("MISSING", p)
        continue
    print("=" * 70)
    print(p.name, "size", p.stat().st_size)
    s = scan(p)
    print("total", s["n"], "keys", s["keys"])
    print("labels", dict(s["labels"]))
    print("reviewed", dict(s["reviewed"]))
    print("sources", s["sources"].most_common(15))
    print("pending", len(s["pending"]), "dropped", len(s["dropped"]), "empty", len(s["empty"]))
    if s["sample"]:
        print("sample", {k: s["sample"].get(k) for k in list(s["sample"])[:14]})
    for name, rows in (("PENDING", s["pending"][:12]), ("DROPPED", s["dropped"][:12]), ("EMPTY", s["empty"][:8])):
        if not rows:
            continue
        print("---", name, "---")
        for r in rows:
            print(
                repr(r.get("author")),
                "|",
                repr((r.get("text") or "")[:140]),
                "|",
                r.get("source"),
                r.get("model"),
                r.get("label"),
            )
