// ============================================================
// /llms.txt が現在の事実を書いていること（2026-09-05 LLMO）。
//
// WHY: llms.txt は「機械に向けた正典」として配っている面で、ここに書いた
// 誤りはそのまま外部の引用になる。2026-09-05 に本番の llms.txt を実測したら
// 3 件が陳腐化していた:
//   1. リポジトリ名を `kzmttkc/agent-trust` と名乗っていた（実際は
//      `kzmttkc/vet402`。旧 URL は 200 でリダイレクトするので壊れて見えない）
//   2. 「L1 purchases are Base-only for now」— 方法論と FAQ は 2026-09-04 に
//      Solana も本番だと言っている（同じ製品が 2 つの答えを配っていた）
//   3. 「as of 2026-08-13 that log is empty」— 訂正ログは 2026-09-04 に
//      非空になっている（実測: /api/v1/observatory/corrections が返す）
//
// 3 つとも「間違っているが 404 にならない」種類なので、実測でしか見つからない。
// この関門は同じ形の腐り方を機械で止める。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const LLMS = readFileSync(join(ROOT, "public/llms.txt"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  repository: { url: string };
};

test("名乗るリポジトリ名は package.json と同じ", () => {
  const slug = pkg.repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)?.[1];
  assert.ok(slug, "package.json の repository.url から slug が取れない");
  assert.ok(LLMS.includes(`https://github.com/${slug}`), `llms.txt が ${slug} を指していない`);
  // 旧 slug を「現在のリポジトリ」として名乗らない（言及自体は履歴として可）。
  assert.ok(
    !/The GitHub repository is (still )?`kzmttkc\/agent-trust`/.test(LLMS),
    "旧リポジトリ名を現在の名前として名乗っている",
  );
});

test("OpenAPI は配信している URL を正典として指す", () => {
  assert.ok(
    LLMS.includes("https://vet402.com/openapi.yaml"),
    "llms.txt が配信中の openapi.yaml を指していない（GitHub の blob だけを指すと、リポ名が変わるたびに引用が腐る）",
  );
});

test("L1 の対応チェーンは方法論と一致する（Base だけだと言わない）", () => {
  assert.ok(!/L1 purchases are Base-only/.test(LLMS), "L1 が Base のみだと書いてある");
  const chainLine = LLMS.split("\n").find((l) => l.includes("L1 purchases run on"));
  assert.ok(chainLine, "L1 の対応チェーンを述べる行が無い");
  assert.ok(chainLine.includes("Base") && chainLine.includes("Solana"));
  const methodology = readFileSync(
    join(ROOT, "src/app/observatory/methodology/page.tsx"),
    "utf8",
  );
  assert.ok(
    methodology.includes("Solana"),
    "方法論が Solana に触れていない。llms.txt だけが先に進んでいる",
  );
});

test("訂正ログの件数を llms.txt に書き止めない", () => {
  assert.ok(
    !/that log is empty/.test(LLMS),
    "訂正ログが空だと書いてある（2026-09-04 に非空になった。件数は API から読ませる）",
  );
  assert.ok(
    LLMS.includes("https://vet402.com/api/v1/observatory/corrections"),
    "件数を読みに行ける JSON を指していない",
  );
});

test("鮮度の宣言がある（更新頻度・キャッシュ窓・取得日の義務）", () => {
  assert.ok(LLMS.includes("## Freshness"), "Freshness 節が無い");
  const section = LLMS.slice(LLMS.indexOf("## Freshness"), LLMS.indexOf("## Legal"));
  for (const needle of ["01:00 UTC", "10:30 UTC", "12:00 UTC", "14:00 UTC", "retrievedAt"]) {
    assert.ok(section.includes(needle), `Freshness 節に ${needle} が無い`);
  }
});

test("宣言した cron の時刻は vercel.json の実物と一致する", () => {
  const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
    crons: { path: string; schedule: string }[];
  };
  const at = (path: string) => {
    const c = vercel.crons.find((x) => x.path === path);
    assert.ok(c, `vercel.json に ${path} が無い`);
    const [minute, hour] = c.schedule.split(" ");
    return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")} UTC`;
  };
  const section = LLMS.slice(LLMS.indexOf("## Freshness"), LLMS.indexOf("## Legal"));
  for (const path of [
    "/api/cron/catalog-sync",
    "/api/cron/l0-probe",
    "/api/cron/l1-purchase",
    "/api/cron/verify-settlements",
  ]) {
    assert.ok(section.includes(at(path)), `${path} の実際の時刻 ${at(path)} が Freshness 節に無い`);
  }
});

test("語彙の正典（1 文定義）へ機械が辿れる", () => {
  assert.ok(LLMS.includes("/observatory/methodology#vocabulary"));
  assert.ok(LLMS.includes("https://vet402.com/llms-full.txt"));
});
