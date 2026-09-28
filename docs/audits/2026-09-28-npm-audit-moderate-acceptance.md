# npm audit（本番依存）moderate 5 件の受容記録 — 2026-09-28

`npm audit --omit=dev`（2026-09-28・origin/main 8e8d6163 の lockfile）の結果は
**moderate 5 / high 0 / critical 0**。5 件は全部 `@solana/web3.js` の下の 1 本の経路で、
`fixAvailable: false`（web3.js 1.x の最新 1.99.0 も `jayson ^4.3.0` のまま）。

ルートの `package.json` / `package-lock.json` は ETHGlobal Tokyo 審査の凍結対象で、
今は `overrides` を足せない。**凍結明けまで受容する。** 理由は下の「影響」。

## 経路

```
vet402
└─ @solana/web3.js@1.98.4          (直接依存。@vet402/sdk も同じものを使う)
   └─ jayson@4.3.0                  (JSON-RPC クライアント)
      ├─ stream-json@1.9.1          GHSA-528h-pc64-c93x
      └─ uuid@8.3.2                 GHSA-w5hq-g745-h8pq
```

| # | パッケージ | 種別 | 勧告 | 範囲 |
|---|---|---|---|---|
| 1 | `stream-json@1.9.1` | 間接 | GHSA-528h-pc64-c93x: pick / ignore / filter / replace のフィルタが入れ子の深さの 2 乗の計算量になり、細工した JSON でイベントループが止まる（DoS） | <=3.4.0 |
| 2 | `uuid@8.3.2`（jayson 配下） | 間接 | GHSA-w5hq-g745-h8pq: v3 / v5 / v6 に `buf` を渡したときの境界検査漏れ | <11.1.1 |
| 3 | `jayson@4.3.0` | 間接 | 1 と 2 を含むため | 2.0.6 – 4.3.0 |
| 4 | `@solana/web3.js@1.98.4` | 直接 | 3 を含むため | 0.0.4 – 1.99.0 |
| 5 | `@vet402/sdk`（ワークスペース） | 直接 | 4 を含むため | — |

## 影響（なぜ今は受容できるか）

- **stream-json は読み込まれない。** web3.js が使うのは `jayson/lib/client/browser`
  だけで（`node_modules/@solana/web3.js/lib/index.cjs.js` の `require('jayson/lib/client/browser')`）、
  このファイルが require するのは `uuid` と `../../generateRequest` の 2 つ。stream-json を
  読むのは jayson の**サーバ側**の `lib/utils.js`（受信ストリームの解析）で、vet402 は
  JSON-RPC サーバを立てていない。
- **uuid は v4 だけ、`buf` なしで呼ばれる。** jayson の `generateRequest.js` は
  `require('uuid').v4` をリクエスト id の生成にだけ使う。勧告は v3 / v5 / v6 に `buf` を
  渡した場合。
- 外部から入る JSON（Solana RPC の応答）は web3.js 自身が `JSON.parse` で読み、stream-json を
  通らない。

以上から、本番の到達経路は 0 と判断する。ただしこれはコードを読んだ判断で、
依存の更新で経路が変わると崩れる。

## 凍結明けにやること

1. ルート `package.json` に `overrides` を足して上げる。候補は 2 つ:
   - `"jayson": "^5.0.0"` — 5.0.0 は `stream-json` と `uuid` への依存自体が無い。
     web3.js 1.x が使う `jayson/lib/client/browser` の API が 5.x でも同じかを
     【要確認】（Solana L1 の pg テストと `npm run sdk:test` で確かめる）。
   - 互換が崩れるなら `"stream-json": "^3.5.0"`・`"uuid": "^11.1.1"` を jayson 配下に
     限定して上げる（stream-json は 1.x → 3.x で import パスが変わるので、jayson の
     サーバ側を読まない限り実害は無いが、`npm ls` で解決を確かめる）。
2. `npm audit --omit=dev` が 0 件になることを確かめる。
3. `unset TEST_DATABASE_URL; npm test` と
   `TEST_DATABASE_URL=… npm run test:db`（Solana L1 のテストを含む）が緑。
4. この文書に「解消: 日付・commit」を 1 行足す。

凍結の解除まで、`npm audit --omit=dev` に **moderate 以外**（high / critical）か、
上の経路の外の新しい件が出たら、この受容は適用しない（別件として扱う）。
