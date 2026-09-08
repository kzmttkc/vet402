/**
 * 「この行を書いたのは、さっきの行を書いたのと同じインスタンスか？」に答える値。
 *
 * WHY (2026-09-08). scoring-probe / payee-probe の memo はモジュールスコープ、
 * つまり **function インスタンス毎**にある。温かいインスタンスは 0.35 秒で
 * キャッシュ済みの ok を返し、キャッシュの無いインスタンスだけが実測へ行く。
 * health_snapshots にこの区別が無い限り、あの表は「時間の変化」ではなく
 * 「インスタンス間の不一致」を記録していても、読んで気づけない。
 *
 * **Vercel が与える識別子は、どれもインスタンスを指さない**（2026-09-08 実測）。
 *
 *   $ curl -sS -I -L https://vet402.com/api/health | grep x-vercel-id
 *   x-vercel-id: hnd1::iad1::wbd9p-1788857954001-36b827352212
 *   x-vercel-id: hnd1::iad1::xjw7t-1788857954436-a7d1b6ef920d
 *   x-vercel-id: hnd1::iad1::lg7vl-1788857954795-6c01c94798ef
 *
 * 3 回とも別の値。`x-vercel-id` は**リクエスト毎**の ID（+ リージョン）であって、
 * 同じインスタンスが 2 回答えても同じにならない。`VERCEL_DEPLOYMENT_ID` は逆に
 * **デプロイ毎**で、1 デプロイの全インスタンスが同じ値を共有する。どちらも
 * 「同一インスタンスかどうか」の判定には使えない。
 *
 * 使えるのは、まさに memo と同じ寿命を持つもの——**モジュール評価時に 1 度だけ
 * 作る値**。この定数が同じ 2 行は、同じ isolate の同じ memo を見ている。
 * リージョンを前置するのは、インスタンスの散り方（hnd1 と iad1 で挙動が違うか）
 * を後から切り分けられるようにするため。
 */

function randomBootId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().slice(0, 8);
  // randomUUID の無い実行環境向けの退避。識別できればよく、暗号強度は要らない。
  return Math.random().toString(16).slice(2, 10);
}

/** モジュール評価時 = memo と同じ寿命。これが同じ 2 行は同じインスタンス。 */
const BOOT_ID = randomBootId();
const BOOTED_AT = Date.now();

/** 例: `hnd1:3f9a1c02`（ローカルは `local:...`）。 */
export function instanceId(): string {
  const region = process.env.VERCEL_REGION?.trim() || "local";
  return `${region}:${BOOT_ID}`;
}

/** このインスタンスが起きてからのミリ秒。冷たい起動直後の失敗を後から見分ける。 */
export function instanceAgeMs(): number {
  return Date.now() - BOOTED_AT;
}
