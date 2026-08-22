// ============================================================
// 2026-08-23 監査 C-6: complete-stripe-setup.sh が本番シークレット5本
// （DATABASE_URL / API_KEY_PEPPER / DASHBOARD_SESSION_SECRET / ADMIN_SECRET /
// CRON_SECRET）を `placeholder` 既定で export し、vercel-env-production.sh が
// `--force` で本番へ上書きしていた。環境変数を揃えずに1回叩けば本番が起動不能に
// なるか、最悪 ADMIN_SECRET=placeholder で管理面が開く。不可逆・一撃。
//
// 実行して確認済み（偽の `vercel` を PATH に置いた隔離環境）:
//   - placeholder → REFUSED、vercel 呼び出し **0回**
//   - 5文字の秘密 → REFUSED、vercel 呼び出し **0回**
//   - 正常値 → preflight 通過後に --force 無しで push
// ここではその守りがスクリプトから消えていないことを固定する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const envScript = readFileSync(join(process.cwd(), "scripts", "vercel-env-production.sh"), "utf8");
const stripeScript = readFileSync(join(process.cwd(), "scripts", "complete-stripe-setup.sh"), "utf8");

test("Stripeセットアップがコアの秘密を placeholder で埋めない", () => {
  assert.doesNotMatch(
    stripeScript,
    /(DATABASE_URL|API_KEY_PEPPER|DASHBOARD_SESSION_SECRET|ADMIN_SECRET|CRON_SECRET)="\$\{[A-Z_]+:-placeholder\}"/,
    "コアの秘密を仮値で既定している——本番を一撃で壊せる",
  );
});

test("Stripeセットアップは対象を Stripe 関連だけに絞っている", () => {
  assert.match(stripeScript, /VERCEL_ENV_ONLY=/, "対象を絞る指定が消えている");
});

test("仮値・短すぎる値を秘密として受け付けない", () => {
  assert.match(envScript, /reject_placeholder/, "仮値の拒否が消えている");
  assert.match(envScript, /placeholder\|changeme/, "既知の仮値リストが消えている");
  assert.match(envScript, /too short for a production secret/, "長さ下限が消えている");
});

test("検査は push より前に全部済ませる（部分的に壊れた状態を残さない）", () => {
  const preflightAt = envScript.indexOf("preflight\n");
  const firstAdd = envScript.indexOf("add_env APP_ENV");
  assert.ok(preflightAt > 0, "preflight の呼び出しが無い");
  assert.ok(
    preflightAt < firstAdd,
    "preflight が最初の add_env より後にある——先に通った分だけ本番へ入って途中で止まる",
  );
});

test("既存値の破壊上書きは VERCEL_ENV_FORCE=1 の明示が要る", () => {
  assert.match(envScript, /VERCEL_ENV_FORCE/, "force の明示化が消えている");
  // 無条件 --force が復活していないこと
  assert.doesNotMatch(
    envScript,
    /vercel env add "\$name" production --force >\/dev\/null$/m,
    "無条件の --force が復活している",
  );
});
