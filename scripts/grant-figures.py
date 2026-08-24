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
        "solTotal": by.get("Solana", {}).get("totalEndpoints"),
        "solActive": by.get("Solana", {}).get("activeEndpoints"),
        "solPass": by.get("Solana", {}).get("publishedPass"),
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


# (regex, [live keys — one per capture group]) — every match must equal the live value(s).
ANCHORS = [
    (r"([\d,]{3,})\s+(?:real\s+)?(?:purchase\s+)?attempts\b(?!\s+that did not settle)", ["attempts"]),
    (r"([\d,]{3,})\s+settled\b", ["settled"]),
    (r"([\d,]{3,})\s+(?:non-settles|attempts that did not settle)\b", ["nonsettled"]),
    (r"([\d,]{3,})\s+endpoints? (?:vet402 tracks|tracked|have appeared)\b", ["total"]),
    (r"([\d,]{3,})\s+delist events\b", ["delistEvents"]),
    (r"([\d,]{3,})\s+relists\b", ["relistEvents"]),
    (r"latest:? (\d{4}-\d{2}-\d{2})", ["snapshotDate"]),
    (r"Latest (\d{4}-\d{2}-\d{2})", ["snapshotDate"]),
    (r"([\d,]{3,}) \(([\d,]{3,}) active, ([\d,]{3,}) delisted\)", ["total", "active", "delisted"]),
    (r"([\d,]{3,}) published \(([\d,]{3,}) not machine-checkable", ["pass", "unverified"]),
    (r"only ([\d,]{3,}) currently have a machine-verified L0 pass; ([\d,]{3,}) are", ["pass", "unverified"]),
    (r"\"([\d,]{3,}) listed\" and \"([\d,]{3,}) active with ([\d,]{3,}) machine-verified live\"", ["total", "active", "pass"]),
    (r"([\d,]{3,}) endpoints fetched", ["snapshotFetched"]),
    (r"([\d,]{3,}) fetched\)", ["snapshotFetched"]),
    (r"\*\*([\d,]{3,}) are on Base mainnet\*\* \(mainnet-only chain breakdown\) — ([\d,]{3,}) of them currently active, and ([\d.]+)% of every mainnet endpoint", ["baseTotal", "baseActive", "baseSharePct"]),
    (r"\| \*\*Base\*\* \| \*\*([\d,]{3,})\*\* \| \*\*([\d,]{3,})\*\* \| \*\*([\d,]{3,})\*\* \|", ["baseTotal", "baseActive", "basePass"]),
    (r"\(after Base at ([\d,]{3,})\)", ["baseTotal"]),
    (r"Base ([\d,]{3,}) · Solana", ["baseTotal"]),
    (r"of which ([\d,]{3,}) settled \(([\d.]+)%\)", ["settled", "settleRatePct"]),
    (r"L0 machine verification: ([\d,]{3,}) published pass", ["pass"]),
    (r"catalog tracking: ([\d,]{3,}) endpoints \(([\d,]{3,}) active\)", ["total", "active"]),
    (r"L1 real purchases: ([\d,]{3,}) attempts / ([\d,]{3,}) settled", ["attempts", "settled"]),
    (r"Lifecycle event stream: ([\d,]{3,}) delists, ([\d,]{3,}) relists", ["delistEvents", "relistEvents"]),
    (r"([\d,]{3,}) delists · ([\d,]{3,}) relists · (\d+) settle-drops", ["delistEvents", "relistEvents", "settleDrops"]),
    (r"\(([\d,]{3,}) delists, ([\d,]{3,}) relists recorded\)", ["delistEvents", "relistEvents"]),
    (r"([\d,]{3,}) endpoints have appeared; ([\d,]{3,}) are currently delisted", ["total", "delisted"]),
    (r"([\d,]{3,}) endpoints, ([\d,]{3,}) of them on Base", ["total", "baseTotal"]),
    (r"attempts across ([\d,]{3,}) (?:distinct )?endpoints", ["endpointsAttempted"]),
    (r"([\d,]{3,}) endpoints are currently delisted", ["delisted"]),
    (r"relists, and (\d+) settle-drops", ["settleDrops"]),
    (r"\| Solana \| ([\d,]+) \| ([\d,]+) \| ([\d,]+) \|", ["solTotal", "solActive", "solPass"]),
    (r"The next-largest chain, Solana, has ([\d,]+)\.", ["solTotal"]),
]


def fmt(v):
    return v if isinstance(v, str) else (f"{v:,}" if isinstance(v, int) else str(v))


def rewrite(f, today):
    """--write: patch every anchored figure to the live value, then re-stamp the date."""
    changed = []
    for p in sorted(DOCS.glob("*.md")):
        if p.name in SKIP:
            continue
        s0 = p.read_text()
        s = s0
        for rx, keys in ANCHORS:
            def sub(m):
                # rebuild by span, never by str.replace — a value like "3" also
                # occurs inside "3,876" and would corrupt the neighbouring number
                out, base = [], m.start(0)
                cursor = 0
                for gi, key in enumerate(keys, start=1):
                    a, b = m.start(gi) - base, m.end(gi) - base
                    out.append(m.group(0)[cursor:a])
                    out.append(fmt(f[key]))
                    cursor = b
                out.append(m.group(0)[cursor:])
                return "".join(out)
            s = re.sub(rx, sub, s)
        s = re.sub(r"(Figures retrieved from [^ ]+ on )\d{4}-\d{2}-\d{2}", r"\g<1>" + today, s)
        s = re.sub(r"(Pre-grant figures retrieved from [^ ]+ on )\d{4}-\d{2}-\d{2}", r"\g<1>" + today, s)
        s = re.sub(r"(checked )\d{4}-\d{2}-\d{2}", r"\g<1>" + today, s)
        if s != s0:
            p.write_text(s)
            changed.append(p.name)
    print("rewrote: " + (", ".join(changed) if changed else "nothing"))
    return 0



def unanchored(f, ):
    """Numbers the anchors never look at are the checker's blind spot. Flag them."""
    live = {fmt(v) for v in f.values() if isinstance(v, int)}
    out = []
    for p in sorted(DOCS.glob("*.md")):
        if p.name in SKIP:
            continue
        for i, line in enumerate(p.read_text().splitlines(), 1):
            for m in re.finditer(r"(?<![$\d.])\b\d{1,3}(?:,\d{3})+\b", line):
                if m.group(0) not in live:
                    out.append(f"{p.name}:{i}  {m.group(0)} matches no live value — anchor it or remove it")
    return out

def check(f, today):
    bad = []
    for p in sorted(DOCS.glob("*.md")):
        if p.name in SKIP:
            continue
        for i, line in enumerate(p.read_text().splitlines(), 1):
            for rx, keys in ANCHORS:
                for m in re.finditer(rx, line):
                    for gi, key in enumerate(keys, start=1):
                        got, want_s = m.group(gi), fmt(f[key])
                        if got.replace(",", "") != want_s.replace(",", ""):
                            bad.append(f"{p.name}:{i}  {key}: doc says {got}, live is {want_s}")
        foot = re.search(r"Figures retrieved from [^ ]+ on (\d{4}-\d{2}-\d{2})", p.read_text())
        if foot and foot.group(1) != today:
            bad.append(f"{p.name}  retrieval date {foot.group(1)} is not today ({today})")
    bad += unanchored(f)
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
    if "--write" in sys.argv:
        rewrite(figures, today)
        sys.exit(check(figures, today))
    if "--check" in sys.argv:
        sys.exit(check(figures, today))
    print(block(figures, today))
