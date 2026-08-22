#!/usr/bin/env python3
"""Grant application figures — fetch live, print canonical block, fail loud on stale docs.

House rule (docs/hackathons/GRANTS.md §4.1): every application says measured facts with a
retrieval date. Numbers written by hand go stale silently. This makes staleness loud.

  python3 scripts/grant-figures.py            # print today's canonical figures block
  python3 scripts/grant-figures.py --check    # exit 1 if any application doc disagrees with live
"""
import json, re, sys, urllib.request, pathlib, datetime

STATE_URL = "https://vet402.com/api/v1/observatory/state"
DOCS = pathlib.Path(__file__).resolve().parent.parent / "docs" / "applications"
# solana-grant-proposal.md is a coherent dated snapshot (cost basis + catalog fetch);
# it is re-quoted whole at submission, not line-patched.
SKIP = {"solana-grant-proposal.md", "video-script.md", "ai-usage-disclosure.md"}


def fetch():
    with urllib.request.urlopen(STATE_URL, timeout=30) as r:
        s = json.load(r)
    by = {c["chain"]: c for c in s["byChain"]}
    base = by.get("Base", {})
    mainnet_total = sum(c["totalEndpoints"] for c in s["byChain"])
    l1 = s["l1"]
    return {
        "total": s["totalEndpoints"],
        "active": s["activeEndpoints"],
        "delisted": s["delistedEndpoints"],
        "pass": s["publishedPass"],
        "unverified": s["publishedUnverified"],
        "attempts": l1["attempts"],
        "settled": l1["settled"],
        "nonsettled": l1["attempts"] - l1["settled"],
        "endpointsAttempted": l1["endpointsAttempted"],
        "delistEvents": s["eventCounts"]["delisted"],
        "relistEvents": s["eventCounts"]["relisted"],
        "settleDrops": s["eventCounts"]["settleDrop"],
        "snapshotDate": s["latestSnapshot"]["snapshotDate"],
        "snapshotFetched": s["latestSnapshot"]["fetchedCount"],
        "baseTotal": base.get("totalEndpoints"),
        "baseActive": base.get("activeEndpoints"),
        "basePass": base.get("publishedPass"),
        "mainnetTotal": mainnet_total,
        "baseSharePct": round(100 * base.get("totalEndpoints", 0) / mainnet_total, 1),
        "settleRatePct": round(100 * l1["settled"] / l1["attempts"], 1),
        "coverage7dPct": s["coverage7d"]["pct"],
    }


def block(f, today):
    g = lambda k: f"{f[k]:,}"
    return f"""# Canonical figures — retrieved {today} from {STATE_URL}

| Metric | Value |
|---|---|
| Endpoints tracked in the public x402 catalog | {g('total')} ({g('active')} active, {g('delisted')} delisted) |
| L0 machine-verified pass | {g('pass')} published ({g('unverified')} not machine-checkable — "unverified", not dead) |
| **L1 real purchases** | **{g('attempts')} attempts across {g('endpointsAttempted')} endpoints — {g('settled')} settled** ({f['settleRatePct']}%); the {g('nonsettled')} non-settles published with the same weight |
| Lifecycle events recorded | {g('delistEvents')} delists · {g('relistEvents')} relists · {f['settleDrops']} settle-drops |
| Daily catalog snapshot | Latest {f['snapshotDate']} — {g('snapshotFetched')} endpoints fetched |
| Base (mainnet-only breakdown) | {g('baseTotal')} tracked · {g('baseActive')} active · {g('basePass')} L0 pass — {f['baseSharePct']}% of {g('mainnetTotal')} mainnet endpoints |
| 7-day L0 coverage | {f['coverage7dPct']}% of active endpoints measured |

Footer to paste: *Figures retrieved from /api/v1/observatory/state on {today}.*
"""


# (regex, live key) — every match in a doc must equal the live value.
ANCHORS = [
    (r"([\d,]{3,})\s+(?:real\s+)?(?:purchase\s+)?attempts\b(?!\s+that did not settle)", "attempts"),
    (r"([\d,]{3,})\s+settled\b", "settled"),
    (r"([\d,]{3,})\s+(?:non-settles|attempts that did not settle)\b", "nonsettled"),
    (r"([\d,]{3,})\s+endpoints? (?:vet402 tracks|tracked|have appeared)\b", "total"),
    (r"([\d,]{3,})\s+delist events\b", "delistEvents"),
    (r"([\d,]{3,})\s+relists\b", "relistEvents"),
    (r"latest:? (\d{4}-\d{2}-\d{2})", "snapshotDate"),
    (r"Latest (\d{4}-\d{2}-\d{2})", "snapshotDate"),
]


def check(f, today):
    bad = []
    for p in sorted(DOCS.glob("*.md")):
        if p.name in SKIP:
            continue
        for i, line in enumerate(p.read_text().splitlines(), 1):
            for rx, key in ANCHORS:
                for m in re.finditer(rx, line):
                    got, want = m.group(1), f[key]
                    want_s = want if isinstance(want, str) else f"{want:,}"
                    if got.replace(",", "") != want_s.replace(",", ""):
                        bad.append(f"{p.name}:{i}  {key}: doc says {got}, live is {want_s}")
        foot = re.search(r"Figures retrieved from [^ ]+ on (\d{4}-\d{2}-\d{2})", p.read_text())
        if foot and foot.group(1) != today:
            bad.append(f"{p.name}  retrieval date {foot.group(1)} is not today ({today})")
    if bad:
        print("STALE — do not submit until fixed:")
        for b in bad:
            print("  " + b)
        return 1
    print(f"OK — application docs agree with live state ({today}).")
    return 0


if __name__ == "__main__":
    figures = fetch()
    today = datetime.date.today().isoformat()
    if "--check" in sys.argv:
        sys.exit(check(figures, today))
    print(block(figures, today))
