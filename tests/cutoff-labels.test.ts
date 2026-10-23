// ============================================================
// 境目の時刻の公開文（2026-10-19 点検の中1・中2）。
// 文は OTHER_CHAIN_QUERY_UNSENT_UNTIL の各グループから組む（Celo 1 つで 4 チェーンを代表させない）。
// 時刻は秒まで・定数から（分で丸めると境目の分の中の行を言い違える）。手書きの時刻が公開面に戻ったら落ちる。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DECLARED_BODY_SENT_SINCE } from "@/lib/observatory/request-body";
import {
  BASE_DECLARED_QUERY_SINCE,
  BASE_DECLARED_QUERY_SINCE_LABEL,
  OTHER_CHAIN_QUERY_UNSENT_UNTIL,
  QUERY_UNSENT_CHAIN_NAMES,
  queryUnsentUntilLabel,
  queryUnsentUntilSentence,
  utcSecondsLabel,
} from "@/lib/observatory/request-query";
import { FIX_MODES } from "@/lib/sellers/fix-modes";

test("utcSecondsLabel: 秒まで・UTC。形が違えば落ちる", () => {
  assert.equal(utcSecondsLabel("2026-10-19T04:05:17Z"), "2026-10-19 04:05:17 UTC");
  assert.throws(() => utcSecondsLabel("2026-10-19T04:05Z"));
  assert.throws(() => utcSecondsLabel("2026-10-19T04:05:17.000Z"));
  assert.throws(() => utcSecondsLabel("2026-10-19 04:05:17"));
  assert.equal(BASE_DECLARED_QUERY_SINCE_LABEL, utcSecondsLabel(BASE_DECLARED_QUERY_SINCE));
});

test("表の network は全部、公開文の名前を持つ（名前の表に余りも無い）", () => {
  const inTable = OTHER_CHAIN_QUERY_UNSENT_UNTIL.flatMap((g) => [...g.networks]).sort();
  assert.deepEqual(Object.keys(QUERY_UNSENT_CHAIN_NAMES).sort(), inTable);
});

test("文は表の各グループを覆う: 各グループの名前と、そのグループの時刻が同じ節に並ぶ", () => {
  const s = queryUnsentUntilSentence();
  for (const g of OTHER_CHAIN_QUERY_UNSENT_UNTIL) {
    const label = utcSecondsLabel(g.until);
    const clause = s.split(/, (?:and )?(?=on )/).find((c) => c.endsWith(`before ${label}`));
    assert.ok(clause, `no clause ends with ${label}: ${s}`);
    for (const n of g.networks) {
      assert.ok(clause.includes(QUERY_UNSENT_CHAIN_NAMES[n]), `${n} missing from "${clause}"`);
      assert.equal(queryUnsentUntilLabel(n), label);
    }
  }
});

test("今の表での文（表を変えたらここも見直す）", () => {
  assert.equal(
    queryUnsentUntilSentence(),
    "on XRPL before 2026-09-21 06:00:30 UTC, on Solana before 2026-10-01 12:00:20 UTC, and on Arc, Celo, Stellar and BNB Chain before 2026-10-19 04:05:17 UTC",
  );
  assert.ok(queryUnsentUntilSentence({ capitalize: true }).startsWith("On XRPL before "));
});

test("公開面に手書きの境目の時刻が無い（分まで・秒まで、どちらも）", () => {
  const files = ["src/app/observatory/methodology/page.tsx", "src/lib/sellers/fix-modes.ts"];
  const literals = [
    DECLARED_BODY_SENT_SINCE,
    BASE_DECLARED_QUERY_SINCE,
    ...OTHER_CHAIN_QUERY_UNSENT_UNTIL.map((g) => g.until),
  ].map((iso) => new RegExp(`${iso.slice(0, 10)}\\s+${iso.slice(11, 16)}`));
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const re of literals) assert.ok(!re.test(src), `${f} still hand-writes ${re.source}`);
    assert.ok(!/SINCE\.slice\(0, 16\)/.test(src), `${f} still rounds a cutoff to the minute`);
  }
});

test("fix-modes の公開文に表の文と秒までの時刻が入る", () => {
  const byKey = new Map(FIX_MODES.map((m) => [m.key, m.what]));
  const q = byKey.get("query_not_sent") ?? "";
  assert.ok(q.includes(queryUnsentUntilSentence()), q);
  assert.ok(q.includes(`Before ${BASE_DECLARED_QUERY_SINCE_LABEL}`), q);
  const c = byKey.get("charged_unsent_input") ?? "";
  assert.ok(c.includes(`the query ${queryUnsentUntilSentence()}`), c);
  assert.ok(c.includes(utcSecondsLabel(DECLARED_BODY_SENT_SINCE)), c);
  assert.ok((byKey.get("body_not_sent") ?? "").startsWith(`Before ${utcSecondsLabel(DECLARED_BODY_SENT_SINCE)},`));
});
