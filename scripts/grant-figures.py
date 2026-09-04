#!/usr/bin/env python3
"""Grant application figures — fetch live, print canonical block, fail loud on stale docs.

House rule (docs/hackathons/GRANTS.md §4.1): every application says measured facts with a
retrieval date. Numbers written by hand go stale silently. This makes staleness loud.

  python3 scripts/grant-figures.py            # print today's canonical figures block
  python3 scripts/grant-figures.py --check    # exit 1 if any application doc disagrees with live
"""
import json, os, re, subprocess, sys, urllib.request, pathlib, datetime

STATE_URL = "https://vet402.com/api/v1/observatory/state"
CENSUS_URL = "https://vet402.com/api/v1/census/summary?window=30d"
DOCS = pathlib.Path(__file__).resolve().parent.parent / "docs" / "applications"
# solana-grant-proposal.md is a coherent dated snapshot (cost basis + catalog fetch);
# it is re-quoted whole at submission, not line-patched.
# 提出済みの申請は「何を送ったか」の記録なので、数字を後から書き換えない。
# 2026-08-25 に Base へ送った Q10 は --write の対象から外す（外さないと記録が偽装になる）。
# --write は「その文書の数字が全部いまの状態の主張である」ものにだけ効かせる。
# 歴史的な比較（「8/14→8/20の7日間は804件だった」）や他チェーンの内訳を含む文書に
# 効かせると、累計値で上書きして事実を壊す（2026-08-29 に solana-grant-proposal.md で実際に起きた）。
# --write の対象外。うち「提出済みの記録」は --check の対象外でもある（記録は直さない）。
# solana-grant-proposal.md は**未提出**なので、書き換えないが**数字は検査する**
# （2026-09-05: SKIP に入れていたせいで「38 of 323 endpoints」という誤り＝実際は31を素通りさせた）。
SKIP_CHECK = {"video-script.md", "ai-usage-disclosure.md",
              "base-builder-grant-nomination.md", "octant-atlas-application.md",
              "base-batches-004-video.md"}
SKIP = {"solana-grant-proposal.md", "video-script.md", "ai-usage-disclosure.md",
        "base-builder-grant-nomination.md", "octant-atlas-application.md",
        # 撮影台本。読み上げる数字は収録当日に vet402_video_numbers.py が出す。
        # ここの数字は例示なので本番値へ書き換えない（書き換えると台本が嘘の数字を固定する）。
        "base-batches-004-video.md"}


def fetch():
    # 公開APIはエッジでキャッシュされる。素のURLで引くと古い値が返る
    # （2026-08-25: settled が 531 と返り、本番DBの実測は 601 だった）。
    # 申請に出す数字なので、必ずキャッシュを外して引く。
    url = STATE_URL + "?_=" + str(int(datetime.datetime.now().timestamp()))
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache",
                                               "User-Agent": "kizuna-grant-figures/1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        s = json.load(r)
    # 2026-09-02: 決済索引が全走査を終え、第三者の実需が公開された。
    # 申請の主張は「自分たちの購入」から「実需の分母＋届いたかの測定」へ厚くなる。
    curl = CENSUS_URL + "&_=" + str(int(datetime.datetime.now().timestamp()))
    creq = urllib.request.Request(curl, headers={"Cache-Control": "no-cache",
                                                 "User-Agent": "kizuna-grant-figures/1"})
    with urllib.request.urlopen(creq, timeout=30) as r:
        c = json.load(r)
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
        "settlementsRaw": c["settlements_raw"],
        "settlementsReal": c["settlements_real"],
        "washTest": c["wash"]["test"],
        "uniquePayersReal": c["unique_payers_real"],
        "uniquePayeesReal": c["unique_payees_real"],
        "endpointsWithRealSettlement": c["endpoints_with_real_settlement"],
        "confirmedAttribution": c["attribution"]["confirmed"],
        "indexFrom": _index_from(),
        **{k: v for k, v in _chain_counts().items() if k.endswith(("Attempts", "Settled", "Endpoints"))},
        "solTotal": by.get("Solana", {}).get("totalEndpoints"),
        "solActive": by.get("Solana", {}).get("activeEndpoints"),
        "solPass": by.get("Solana", {}).get("publishedPass"),
    }


def _index_from():
    """census の window は名乗りであって、索引が実際にどこまで遡れているかとは別物。
    2026-09-03: window=30d の実体は 09-01 以降の約2日だった。申請に出す前に必ず実測する。"""
    env = pathlib.Path.home() / "vouch" / ".env.production.local"
    url = ""
    try:
        for line in env.read_text().splitlines():
            if line.startswith("DATABASE_URL="):
                url = line.split("=", 1)[1].strip().strip('"').strip("'"); break
    except Exception:
        return "不明"
    psql = next((c for c in ("/opt/homebrew/bin/psql", "/usr/local/bin/psql") if os.path.exists(c)), "psql")
    try:
        out = subprocess.run([psql, url, "-At", "-c",
                              "select to_char(min(observed_at) at time zone 'utc','YYYY-MM-DD') from settlements;"],
                             capture_output=True, text=True, timeout=40)
        return out.stdout.strip() or "不明"
    except Exception:
        return "不明"


def _chain_counts():
    """チェーン別の settled 件数を本番DBから引く。主張の検査に使う。"""
    env = pathlib.Path.home() / "vouch" / ".env.production.local"
    url = ""
    try:
        for line in env.read_text().splitlines():
            if line.startswith("DATABASE_URL="):
                url = line.split("=", 1)[1].strip().strip('"').strip("'"); break
    except Exception:
        return {}
    psql = next((c for c in ("/opt/homebrew/bin/psql", "/usr/local/bin/psql") if os.path.exists(c)), "psql")
    sql = ("select case when network like 'solana%' then 'solana' when network like 'eip155:8453' then 'base' "
           "else 'other' end, count(*), count(*) filter (where status='settled'), count(distinct endpoint_id) "
           "from x402_l1_purchases group by 1;")
    try:
        out = subprocess.run([psql, url, "-At", "-F", "|", "-c", sql], capture_output=True, text=True, timeout=60)
        d = {}
        for r in out.stdout.strip().splitlines():
            if "|" not in r:
                continue
            ch, att, st, eps = r.split("|")
            d[ch] = int(st)                      # 主張の検査は settled で足りる
            d[ch + "Attempts"] = int(att)
            d[ch + "Settled"] = int(st)
            d[ch + "Endpoints"] = int(eps)
        return d
    except Exception:
        return {}


# 主張の検査（2026-09-05 追加）。
# --write は「文の中の数字」を本番値へ更新するが、**その文の主張が古くなったことは見ない**。
# 実際に why-solana.md は「Solana では実購入していない。3,241 件は全て Base」と書いたまま、
# 数字だけ 845→3,241 へ自動更新され、**嘘が最新の実測に見える状態**になっていた（別セッションの指摘で発覚）。
# 数字が合っていることと、主張が正しいことは別物である。
CLAIM_GUARDS = [
    (r"does not (?:make|settle) real purchases on Solana",
     lambda f, c: c.get("solana", 0) > 0,
     "Solana の settled が {solana} 件ある（本番DB実測）"),
    (r"Every one of those attempts was a USDC payment on Base",
     lambda f, c: c.get("solana", 0) > 0,
     "Solana の settled が {solana} 件ある（全件が Base ではない）"),
    (r"real purchases are Base-only",
     lambda f, c: c.get("solana", 0) > 0,
     "Solana の settled が {solana} 件ある（本番DB実測）"),
    (r"attempts to date \([\d,]+ settled\) were on Base",
     lambda f, c: c.get("solana", 0) > 0,
     "全件が Base ではない。Solana settled {solana} 件"),
    (r"L1 (?:is |runs )?(?:on )?Base only",
     lambda f, c: c.get("solana", 0) > 0,
     "Solana の settled が {solana} 件ある"),
]


def check_claims(f):
    """凍結済み（SKIP）の文書も含めて全部見る。提出済みなら直せないが、知らないままにはしない。"""
    chains = _chain_counts()
    bad = []
    for p in sorted(DOCS.glob("*.md")):
        text = p.read_text()
        for i, line in enumerate(text.splitlines(), 1):
            for rx, cond, msg in CLAIM_GUARDS:
                if re.search(rx, line) and cond(f, chains):
                    frozen = " ※提出済みの記録" if p.name in SKIP_CHECK else ""
                    bad.append(f"{p.name}:{i}  主張が実測と矛盾: " + msg.format(**chains) + frozen)
    return bad


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
| ~~Real third-party demand~~ | **申請に使わない（2026-09-03）**: census は `window=30d` と名乗るが、索引は {f['indexFrom']} 以降しか入っていない（実測）。API が実際の索引範囲を開示するまで、この数字を申請文に書かない |

Footer to paste: *Figures retrieved from /api/v1/observatory/state on {today}.*
"""


# (regex, [live keys — one per capture group]) — every match must equal the live value(s).
ANCHORS = [
    # 「250 attempts/day」のような目標値は実測ではないので見ない
    (r"([\d,]{3,})\s+(?:real\s+)?(?:purchase\s+)?attempts\b(?!/day)(?!\s*/\s*day)(?!\s+that did not settle)", ["attempts"]),
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
    (r"We buy: ([\d,]{3,}) real USDC purchases on Base mainnet across ([\d,]{3,}) endpoints, ([\d,]{3,}) settled", ["attempts", "endpointsAttempted", "settled"]),
    (r"the ([\d,]{3,}) that did not settle", ["nonsettled"]),
    (r"([\d,]{2,}) real purchase attempts on Solana mainnet", ["solanaAttempts"]),
    (r"([\d,]{3,}) paid attempts on Base mainnet, of which ([\d,]{3,}) reached settlement", ["baseAttempts", "baseSettled"]),
    (r"out of ([\d,]{3,}) attempts and ([\d,]{3,}) settlements in total", ["attempts", "settled"]),
    (r"([\d,]{2,}) settled and all ([\d,]{2,}) are chain-verified", ["solanaSettled", "solanaSettled"]),
    (r"([\d,]{3,}) of our ([\d,]{3,}) attempts to date are on Base", ["baseAttempts", "attempts"]),
    (r"([\d,]{2,}) attempts / ([\d,]{2,}) chain-verified settlements", ["solanaAttempts", "solanaSettled"]),
    (r"([\d,]{2,}) of 323 in-cap Solana endpoints have ever been bought from", ["solanaEndpoints"]),

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
        if p.name in SKIP_CHECK:
            continue
        for i, line in enumerate(p.read_text().splitlines(), 1):
            # 日付を明記した実測値（原価根拠など）は本番stateと一致しなくてよい。
            # 「その日に測った」と書いてあることが根拠なので、日付が無い数字だけを咎める。
            # ISO 日付が同じ行にある＝「その日に測った/引用した」と書いてある。
            # 生きた指標のズレはアンカーが別に見るので、日付つきの行はこの網から外す。
            if re.search(r"20\d\d-\d\d-\d\d|base units|requested amount", line, re.I):
                continue
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
    bad += check_claims(f)
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
