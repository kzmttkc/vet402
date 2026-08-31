# パートナー窓口へ投げる文面（貼り付け用・正典）

> 2026-08-31。**この文面の正典はここ**。`.company/TAKESHI_TODO.md` は複数セッションが触るため、
> 一度この内容が消えた（8/31 の再構成で紛失）。TODO からはここを指すだけにする。
> Discord への投稿は私からできない（vet402 の Discord は 2FA 端末が修理中）ため、Takeshi の手番。
> 前提: partner channel は「今週後半に開く」と運営（Pascal）が 2026-08-25 に回答済み。

---

## (A) The Graph のチャンネルへ ← **最優先**（$5,000・我々の最有力枠）

背景: 2026-08-31 に continuity 専用枠が3つ公開された。狙うのは
🔧 **Best AI Tooling for The Graph**（賞文に「MCP servers … x402 payment tooling」が名指しで入っている）。
要件に「Graph プロバイダの**生データ**を消費すること。モック・ローカルのみ・静的は不可」とある。

```
Hi — Continuity-track team here (vet402, MIT: https://github.com/kzmttkc/vet402). We maintain an independent verification layer for x402 agent payments, including a public MCP server.

We're planning to submit to "Best AI Tooling for The Graph". What we add during the event is a payment primitive that refuses to sign unless the payee clears evidence floors the caller names — and we want the evidence to come from The Graph rather than only from our own database, so a third party can check it independently. The MCP server would expose that as a reusable tool.

Two questions before we build:

1. To satisfy "consume live data from a Graph provider", is querying an existing Subgraph through the Gateway enough, or do you expect us to author/deploy a Subgraph of our own?
2. Is there a Subgraph you'd point us at for ERC-20 (USDC) transfer history on Base, or would a Standardized/Messari schema be the better base for that?

Happy to share the design doc if useful.
```

---

## (B) World のチャンネルへ（$3,500・continuity 限定枠）

```
Hi — we're on the Continuity track with vet402 (MIT, https://github.com/kzmttkc/vet402), an independent verification layer for x402 agent payments. We're planning to build for the AgentKit Continuity bracket. Two things we could not settle from the docs:

1. Which chain does AgentBook resolve on for this hackathon? The integrate guide says World Chain, while the repo README mentions a hosted relay on Base mainnet (with Base Sepolia as an alternative). Which should we target?
2. What verification level does the registering human need — is World App device verification enough, or is Orb required?

And a fit check: the new work we add during the event is a payment primitive that refuses to sign unless the payee has delivery evidence. We would add a payer-side condition so that a human-backed agent resolved through AgentBook gets a raised spend ceiling, while an unverified agent stays at the default. Does that count as meaningful AgentKit use for the bracket?
```

---

## (C) continuity 枠がまだ無いパートナーへ（1社ずつ）

対象（2026-08-31 時点で詳細 "coming soon" または continuity 枠なし）: **ENS / Ledger / Privy / Chainlink**。
（Arc は $2,500 に減額・continuity 枠なし・要件も Arc 上の DeFi なので**対象外**。
Hedera / 1inch / Uniswap は continuity 枠があるが要件が合わない。）

```
Hi — a request from a Continuity-track team. ETHGlobal confirmed that continuity submissions can only select prizes that carry the continuity label: a non-continuity bracket cannot be selected even when the work fits it exactly.

If your prizes are not final yet, would you consider adding a continuity bracket? We are extending an existing MIT project (independent verification for x402 agent payments) and would otherwise not be able to submit to you at all. Happy to describe what we are building if that helps.
```

---

## (D) ETHGlobal Tokyo 側（9/23 の申請期限まで）

Tokyo は 5社・$45,000 で **continuity 枠がゼロ**（2026-08-31 実測）。詳細待ちが4社あるので、
Tokyo のチャンネルが開いたら (C) を World / ENS / Uniswap / 1inch に同じ文面で投げる。
枠が付かなければ Tokyo は賞を狙わず、現地は接触に振る（[`../hackathons/STRATEGY.md`](../hackathons/STRATEGY.md) §6）。

---

**返ってきたら伝えること**: どのチャンネルに投げたかと、返信の全文（スクショで可）。
The Graph の回答は会期の実装順に直結する（証拠源を Subgraph にするかどうか）。
