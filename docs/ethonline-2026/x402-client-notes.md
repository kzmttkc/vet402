# x402 クライアント調査メモ（B4・コードは書かない）

> 2026-08-25。出典は x402-foundation/x402 の README（一次）。会期中に `exact` を SDK から
> 呼ぶために必要な手順とパッケージ名だけを控える。**この時点で我々のリポに実装は入れない。**

## 公式パッケージ（払う側）

- `@x402/core` — 基盤
- ネットワーク: `@x402/evm` / `@x402/svm` / `@x402/avm` / `@x402/aptos` / `@x402/stellar` / `@x402/tvm` / **`@x402/hedera`** / `@x402/keeta`
- HTTPクライアント: `@x402/fetch` / `@x402/axios`

売る側（自前 seller を立てる場合）: `@x402/core` ＋ `@x402/express` / `@x402/fastify` / `@x402/hono` / `@x402/next`

**`@x402/hedera` が公式に存在する**——Hedera「AI & Agentic Payments」$6,000 を狙う場合、
チェーン対応は自前実装ではなく公式パッケージ＋Blocky402 facilitator の組み合わせになる
（賞の要件は [`PRIZES.md`](./PRIZES.md)。対象可否は確認中）。

## `exact` の流れ（8段）

1. クライアントがリソースを要求
2. サーバが **402 Payment Required** ＋ `PAYMENT-REQUIRED` ヘッダで支払い条件を返す
3. クライアントが `PaymentPayload` を作り `PAYMENT-SIGNATURE` ヘッダで送る
4. サーバがローカル、または facilitator `/verify` で検証
5. 検証が通ればリクエストを処理
6. サーバがチェーンへ送信、または facilitator `/settle` を呼ぶ
7. facilitator がトランザクションを実行・確定
8. サーバが **200 OK** ＋ `PAYMENT-RESPONSE` ヘッダを返す

我々の `payOrRefuse` が割り込むのは **2 と 3 のあいだ**。402 を受けた直後、
`PaymentPayload` を作る前に policy を評価し、通らなければ **3 に進まない**。
署名が発生しないのはこの位置に居るからで、支払い後に取り消しているわけではない。

## 会期中に確かめること（実装時の落とし穴）

- 402 の `PAYMENT-REQUIRED` に載る `payTo` が、我々が採点した `payee` と一致するか（不一致は `payee_mismatch`）
- `exact` の asset が Base 正規 USDC か（別トークンや別チェーンは拒否）
- 上限（既定 $1）は payload を作る前に評価する
- facilitator の `/settle` が失敗したときの返り値と、我々の attest の関係
- signer は policy 通過後にだけ渡す（そもそも呼べない構造にする）

## 参照

- https://github.com/x402-foundation/x402
- Blocky402 facilitator（Hedera 賞の必須要件）: https://blocky402.com/
