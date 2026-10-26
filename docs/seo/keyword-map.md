# キーワード地図（2026-10-26）

Google Search Console の 2026-10-19 の週は、トップと /faq など社名と案内の表示だけで、話題の検索語の表示は 0 だった。この表は、各ページが答える検索意図と、事実の文に自然に入れる語を固定する。詰め込みはしない。数字はページが計器から読む。

売り手の一覧（/sellers と個別頁）は 2026-09-29 の帰属の見直しが済むまで noindex なので、索引の対象にしない。

## ページ

| ページ | 検索意図 | 入れる語 | 入れ方 |
| --- | --- | --- | --- |
| / | x402 の支払いを、払う前に確かめたい | x402 payments for AI agents, USDC, check a seller | H1「Paid is on chain. Delivered is not.」は残す。その下の文に語を入れる |
| /faq | x402 とは何か | what is x402, HTTP 402, AI agents, USDC | 導入の先頭 2 文で言い切る。設問の本文は変えない |
| /blog/what-is-x402 | x402 の説明を読みたい | what is x402, HTTP 402 payments for AI agents | 検索用の title と description だけ。本文と H1 と updatedAt は変えない |
| /x402/stablecoin-payments | エージェントがステーブルコインでどう払うか | AI agent payments, stablecoin, USDC, x402, pay-per-call | 新しい頁。先頭 3 文で言い切る |
| /x402/check-a-seller | 払う前に売り手を見たい | verify an x402 seller, check before paying | 新しい頁。decision と購入記録の読み方 |
| /x402/chains と /x402/chains/{slug} | チェーン別の x402 | x402 on Base, Solana, Arc, Celo。Tempo は MPP と USDC.e。XRPL は RLUSD | 購入レーン 6 本だけ。件数は台帳の行があるときだけ |
| /docs/api | 払う前の判定 API | decision API, x402 agent payments | H1 は API reference のまま。表題と導入に語を足す |
| /observatory | 測定の一覧 | x402 observatory, agent payments | 登録済みの説明の前半は残す。リンクを 1 行足す |
| /observatory/state | チェーン別の集計 | state of x402 payments by chain | H1 は State of x402 のまま。L0 の CSV へのリンクを足す |
| /observatory/methodology | 測り方 | methodology, x402 payment measurements | H1 は残す。チェーン頁への 1 文だけ足す |
| /impact | 公開している測定 | public x402 payment measurements | 表題のダッシュをやめる。Dataset を足す |
| /blog | 解説の一覧 | notes on x402 agent payments | 一覧の H1 と、各記事の末尾の関連リンク |
| /sellers | 自分のドメインの購入結果（noindex） | check an x402 seller | 索引には出さない。確認頁への 1 文と WebPage だけ |

チェーン頁を置かないもの: Stellar、BNB Chain は台帳に行があればハブで名前と件数を出し、/observatory/state へ送る。Arbitrum One は最初の決済までレーンを出さない。Robinhood Chain は /rwa のまま触らない。

## GSC で毎週見る検索語

表示・クリック・平均順位を、この並びで見る。社名 `vet402` は指名検索の対照にする。

- x402
- what is x402
- x402 protocol
- HTTP 402 payments
- AI agent payments
- agentic payments
- agent commerce
- x402 payments
- stablecoin payments for AI agents
- USDC micropayments
- pay per call API
- verify x402 seller
- check x402 seller before paying
- x402 on Base
- x402 on Solana
- x402 on Arc
- x402 on Celo
- x402 USDC
- x402 Tempo
- x402 XRPL
- vet402

`agentic payments` と `agent commerce` は、安定コインの頁とトップの文脈で拾う。専用の頁は作らない。
