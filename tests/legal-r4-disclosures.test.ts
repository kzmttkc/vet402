// ============================================================
// 2026-09-29 敵対的監査 4 周目（規制当局・コンプライアンスの立場）で直した法務面を固定する。
//
// 1. 特商法: /legal/notice は「適用されない」を撤回し、11 条の表示を持つ。価格は
//    BILLING_PLANS から描画する（表示と課金の数字がずれない）。
// 2. 最終確認画面（12 条の 6）: Upgrade は確認を開くだけで、Stripe へ進む／契約を変える
//    のは確認の中のボタンだけ。確認には価格・周期・自動更新・支払時期・解約方法が並ぶ。
// 3. 独立性の開示: /legal/notice#relationships と中立の規則。
// 4. メール: 売り手への公開前通知を目的・入手元・停止方法とともに開示し、
//    「Resend は通知と異議の返信だけ」という旧記述を残さない。
// 5. 個人情報: 「in good faith」を削り、管理者の身元・保存先の国・安全管理措置・外部送信を書く。
// 6. 規約: 手法のリンクは /observatory/methodology、「verified payee」を名乗らせない、
//    §13 に L1 異議の扱い（実装にあることだけ）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BILLING_PLANS } from "@/lib/billing/plans";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const squash = (s: string) => s.replace(/\s+/g, " ");

test("notice: carries the Specified Commercial Transactions disclosure and no longer says it does not apply", () => {
  const notice = squash(read("src/app/legal/notice/page.tsx"));
  assert.match(notice, /Disclosure under Japan&apos;s Act on Specified Commercial Transactions/);
  assert.match(notice, /id="commercial-transactions"/);
  assert.match(notice, /proviso to Article 11 of the Act/);
  assert.doesNotMatch(notice, /do not currently apply/);
  assert.doesNotMatch(notice, /good faith/);
  for (const label of [
    "Seller",
    "Contact",
    "Price",
    "Other charges",
    "Payment method",
    "When you pay",
    "When the service is provided",
    "Cancellation",
    "Refunds",
    "Operating environment",
  ]) {
    assert.ok(notice.includes(`>${label}</dt>`), `disclosure row missing: ${label}`);
  }
  // 価格は BILLING_PLANS から描画する（手書きの数字を置かない）。
  assert.match(notice, /BILLING_PLANS\[id\]/);
  assert.match(notice, /plan\.monthlyUsd/);
});

test("plans: the numeric monthly price agrees with the label shown on Billing and pricing", () => {
  for (const plan of Object.values(BILLING_PLANS)) {
    assert.ok(plan.priceLabel.startsWith(`$${plan.monthlyUsd}`), `${plan.name}: ${plan.priceLabel} vs ${plan.monthlyUsd}`);
  }
});

test("billing: Upgrade opens a final confirmation; only the confirmation proceeds to Stripe", () => {
  const billing = squash(read("src/app/dashboard/billing/page.tsx"));
  assert.match(billing, /function OrderConfirmation/);
  // プランのカードのボタンは確認を開くだけ。
  assert.doesNotMatch(billing, /onClick=\{\(\) => upgrade\(planId\)\}/);
  assert.match(billing, /onConfirm=\{\(\) => upgrade\(confirming\)\}/);
  // 12 条の 6 の表示事項。
  assert.match(billing, /renews automatically every month until you cancel/);
  assert.match(billing, /charged in advance at the start of each/);
  assert.match(billing, /Manage subscription/);
  assert.match(billing, /No refunds for unused lookups or unused time/);
  assert.match(billing, /Continue to payment/);
  assert.match(billing, /\/legal\/notice#commercial-transactions/);
});

test("notice: relationships are disclosed with the neutrality rule", () => {
  const notice = squash(read("src/app/legal/notice/page.tsx"));
  assert.match(notice, /id="relationships"/);
  assert.match(notice, /Relationships: grants and prizes received/);
  assert.match(notice, /no grant, prize, application or payment changes how we measure/);
  // 2026-09-29: 載せるのは受け取った助成・賞だけ（申請中・見送りは資金の関係ではなく、運営者の申請歴を公開してしまう）。
  assert.ok(notice.includes("Bazantic"), "relationship row missing: Bazantic");
  for (const pending of ["Circle Developer Grants", "Base Ecosystem Fund", "MITOU", "Octant"]) {
    assert.ok(!notice.includes(pending), `pending application should not be listed: ${pending}`);
  }
});

test("privacy: seller notices, controller identity, storage countries, security and external transmission", () => {
  const privacy = squash(read("src/app/legal/privacy/page.tsx"));
  assert.match(privacy, /id="seller-notices"/);
  assert.match(privacy, /records@vet402\.com/);
  assert.match(privacy, /Where the address comes from/);
  assert.match(privacy, /How to stop them/);
  assert.doesNotMatch(privacy, /It is not used for marketing, and there is no newsletter\./);
  assert.match(privacy, /pre-publication notices we send to sellers/);
  assert.match(privacy, /The controller of the personal data/);
  assert.match(privacy, /id="where-stored"/);
  assert.match(privacy, /United States/);
  assert.match(privacy, /European Union \(Germany\)/);
  assert.match(privacy, /id="security"/);
  assert.match(privacy, /id="external-transmission"/);
  assert.match(privacy, /plausible\.io/);
  assert.match(privacy, /Revision: <span className="text-signal">September 29, 2026/);
});

test("terms: methodology link, no 'verified payee' registration, L1 disputes, seller notices", () => {
  const terms = squash(read("src/app/legal/terms/page.tsx"));
  const sec6 = terms.slice(terms.indexOf('sec-no">6.'), terms.indexOf('sec-no">7.'));
  assert.match(sec6, /href="\/observatory\/methodology"/);
  assert.doesNotMatch(sec6, /methodology we publish at\{" "\} <a className="doc-link" href="\/accuracy">/);
  assert.doesNotMatch(terms, /registers you as a verified payee/);
  assert.match(terms, /address control verified/);
  const sec13 = terms.slice(terms.indexOf('sec-no">13.'), terms.indexOf('sec-no">14.'));
  assert.match(sec13, /Disputing a purchase \(L1\) result/);
  assert.match(sec13, /does not currently carry a &quot;disputed&quot; marker/);
  assert.match(sec13, /a dispute does not start a new purchase/);
  const sec16 = terms.slice(terms.indexOf('sec-no">16.'));
  assert.match(sec16, /notices to a seller before we publish/);
  assert.match(sec16, /renews automatically each month/);
});

test("footers link the commercial disclosure and the relationships section", () => {
  for (const f of ["src/components/site/SiteFooter.tsx", "src/components/dashboard/shell.tsx"]) {
    const src = read(f);
    assert.ok(src.includes("/legal/notice#commercial-transactions"), `${f}: commercial disclosure link`);
    assert.ok(src.includes("/legal/notice#relationships"), `${f}: relationships link`);
  }
});
