// ============================================================
// 登録ドメイン（eTLD+1）——L1 の売り手ごとの日次上限の 3 つ目の単位（2026-09-29 監査 6 周目・高・お金）。
//
// 攻撃の形: 受取先（payTo）ごと・ホストごとの $2 の上限は、サブドメインを増やし payTo を分ければ
// いくらでも回避できる（a1.evil.com・a2.evil.com … にそれぞれ別の payTo）。持ち主の単位は登録ドメイン。
//
// 公開サフィックスリスト（PSL）の実装を依存に持っていない（tldts は jsdom 経由の dev 依存だけで本番の
// バンドルに入らない・package.json は凍結）。だから PSL の中から「本番のカタログに実在する共有ドメイン」と
// 主要な 2 段の国別ドメインを定数で持つ簡易の実装にする。ここに無い共有ドメインは 2 段（example.com）で
// 数える＝**上限が締まる側へ倒れる**（多くの別の持ち主を 1 つに数え、払いすぎない）。
//
// 本番の実測（2026-09-29・https で pay_to のある出品のホスト）: workers.dev 320・vercel.app 159・
// railway.app 139・onrender.com 82・run.app 71・trycloudflare.com 65・fly.dev 42・sslip.io 15・
// ts.net 9・duckdns.org 8・netlify.app 6・ondigitalocean.app 6・lhr.life 5・co.uk 5・replit.app 4・
// azurecontainerapps.io 4・execute-api（amazonaws.com）4・ngrok-free.dev 4。
//
// 2026-09-29 独立レビュー（中）: トンネル・動的 DNS（trycloudflare.com・sslip.io・nip.io・loca.lt・serveo.net・
// lhr.life・ngrok 系・duckdns.org・ts.net）は、無料で・多くはアカウント無しで名前をいくらでも作れる。表に置くと
// 「1 つ下が別の持ち主」になり、名前を増やすだけで $3 の上限を何枠でも取れた。だから**表から外し、サフィックスごとに
// 1 枠**にまとめる（x.trycloudflare.com も y.trycloudflare.com も trycloudflare.com）＝締まる側。POOLED_SUFFIXES は
// その一覧で、読み込み時に「表に無い・2 段」を確かめる（2 段なら既定の 2 段の規則でサフィックスそのものになる。
// JS も SQL も同じ表から作るので、両方が同じ 1 枠を数える）。
//
// 規則（PSL と同じ）: 一致する最も長いサフィックスの 1 つ下のラベルまで。`*` は任意の 1 ラベル
// （PSL のワイルドカード）。IP リテラルはホストそのもの。JS（registeredDomainOf）と SQL（registeredDomainSql）は
// 同じ表から作る——片方だけ直すと、候補 SQL と予約で別の単位を数える。
// ============================================================
import { sql, type SQL } from "drizzle-orm";

/**
 * 公開サフィックス（小文字・`*` は任意の 1 ラベル）。「サブドメインが別の持ち主」になる共有ドメインと、
 * 2 段の国別ドメイン。足すときは tests/audit-r6-security.test.ts（JS の単位）と tests/audit-r6-security.pg.test.ts
 * （JS と SQL の一致）の検査も通す。トンネル・動的 DNS は載せない（POOLED_SUFFIXES）。
 */
export const PUBLIC_SUFFIXES: readonly string[] = [
  // --- ホスティング・PaaS（PSL の private 節）---
  "workers.dev",
  "pages.dev",
  "vercel.app",
  "now.sh",
  "netlify.app",
  "onrender.com",
  "github.io",
  "gitlab.io",
  "herokuapp.com",
  "fly.dev",
  "up.railway.app",
  "railway.app",
  "replit.app",
  "replit.dev",
  "repl.co",
  "deno.dev",
  "glitch.me",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "*.run.app",
  "a.run.app",
  "cloudfunctions.net",
  "azurewebsites.net",
  "azurestaticapps.net",
  "*.azurecontainerapps.io",
  "cloudfront.net",
  "amplifyapp.com",
  "execute-api.*.amazonaws.com",
  "elb.amazonaws.com",
  "*.elb.amazonaws.com",
  "lambda-url.*.on.aws",
  "ondigitalocean.app",
  "hf.space",
  "streamlit.app",
  "modal.run",
  "supabase.co",
  "koyeb.app",
  "zeabur.app",
  "surge.sh",
  // --- トンネル・動的 DNS は載せない（POOLED_SUFFIXES・サフィックスごとに 1 枠）---
  // --- 2 段の国別ドメイン ---
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "go.jp",
  "com.br",
  "com.cn",
  "com.hk",
  "com.tw",
  "com.sg",
  "com.my",
  "com.mx",
  "com.ar",
  "com.tr",
  "co.in",
  "co.kr",
  "co.nz",
  "co.za",
  "co.id",
  "co.il",
  "co.th",
];

/**
 * サフィックスごとに 1 枠にまとめる共有ドメイン（トンネル・動的 DNS・2026-09-29 独立レビュー）。名前を無料で
 * いくらでも作れるので、1 つ下を別の持ち主に数えない。PUBLIC_SUFFIXES に載せず、2 段なので既定の規則で
 * サフィックスそのもの（trycloudflare.com）が単位になる。本番の実測: trycloudflare.com 65・sslip.io 15・ts.net 9・
 * duckdns.org 8・lhr.life 5・ngrok-free.dev 4（2026-09-29・上の表の件数）。
 */
export const POOLED_SUFFIXES: readonly string[] = [
  "trycloudflare.com",
  "ngrok.io",
  "ngrok.app",
  "ngrok.dev",
  "ngrok-free.app",
  "ngrok-free.dev",
  "loca.lt",
  "lhr.life",
  "localhost.run",
  "sslip.io",
  "nip.io",
  "duckdns.org",
  "ts.net",
  "serveo.net",
];

const LABEL = /^(\*|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/;
for (const s of PUBLIC_SUFFIXES) {
  // SQL へ文字列として埋めるので、形を読み込み時に固定する（引用符・バックスラッシュが入る余地を無くす）。
  if (!s.split(".").every((l) => LABEL.test(l))) throw new Error(`invalid public suffix: ${s}`);
}
for (const p of POOLED_SUFFIXES) {
  // 1 枠にまとめる前提（表に無い・2 段）が崩れたら読み込みで止める——表の 1 つ下の規則が効くと枠が増える。
  const n = p.split(".").length;
  if (n !== 2 || PUBLIC_SUFFIXES.some((s) => s === p || s.endsWith(`.${p}`))) throw new Error(`pooled suffix must be 2 labels and absent from PUBLIC_SUFFIXES: ${p}`);
}

const SUFFIX_LABELS = PUBLIC_SUFFIXES.map((s) => s.split("."));

function isIpLiteral(host: string): boolean {
  return host.startsWith("[") || host.includes(":") || /^[0-9]+(\.[0-9]+){3}$/.test(host);
}

/**
 * ホスト名（小文字・ポート無し。censusHostOf の出力）の登録ドメイン。読めない形（空・IP リテラル）は
 * ホストそのもの。サフィックスそのもの（github.io）はそれ自身。
 */
export function registeredDomainOf(host: string): string {
  const h = host.toLowerCase().replace(/:[0-9]+$/, "").replace(/\.+$/, "");
  if (h === "" || isIpLiteral(h)) return h;
  const labels = h.split(".");
  let suffixLen = 1;
  for (const s of SUFFIX_LABELS) {
    if (s.length <= suffixLen || s.length > labels.length) continue;
    const tail = labels.slice(labels.length - s.length);
    if (s.every((l, i) => l === "*" || l === tail[i])) suffixLen = s.length;
  }
  if (labels.length <= suffixLen) return h;
  return labels.slice(labels.length - suffixLen - 1).join(".");
}

/** サフィックスの正規表現（POSIX ARE・バックスラッシュを使わない——standard_conforming_strings に依らない）。 */
function suffixRegex(s: string): string {
  return s
    .split(".")
    .map((l) => (l === "*" ? "[^.]+" : l.replace(/-/g, "[-]")))
    .join("[.]");
}

/** 末尾 n ラベル。ラベルが n 以下ならホストそのもの。 */
const lastLabelsSql = (h: SQL, n: number) =>
  sql`array_to_string((string_to_array(${h}, '.'))[greatest(array_length(string_to_array(${h}, '.'), 1) - ${sql.raw(String(n - 1))}, 1):], '.')`;

/**
 * registeredDomainOf の SQL 版。引数はホスト名の式（censusHostSql の出力＝小文字・ポート無し）。
 * 長いサフィックスから順に CASE で当てる（JS の「最も長い一致」と同じ）。
 */
export function registeredDomainSql(host: SQL): SQL {
  const byLen = new Map<number, string[]>();
  for (const s of PUBLIC_SUFFIXES) {
    const n = s.split(".").length;
    if (n < 2) continue;
    byLen.set(n, [...(byLen.get(n) ?? []), suffixRegex(s)]);
  }
  const lens = [...byLen.keys()].sort((a, b) => b - a);
  // ホストの式は 1 回だけ評価する（副問い合わせの列 rd_h）。式そのものを CASE の各枝へ埋めると、
  // censusHostSql の正規表現が行ごとに枝の数だけ走る。
  const h = sql.raw("rd_h");
  const branches = lens.map(
    (n) => sql` WHEN ${h} ~ ${sql.raw(`'(^|[.])(${byLen.get(n)!.join("|")})$'`)} THEN ${lastLabelsSql(h, n + 1)}`,
  );
  return sql`(SELECT CASE WHEN ${h} = '' OR ${h} LIKE '[%' OR ${h} LIKE '%:%' OR ${h} ~ '^[0-9]+([.][0-9]+){3}$' THEN ${h}${sql.join(branches, sql``)} ELSE ${lastLabelsSql(h, 2)} END
    FROM (SELECT rtrim(${host}, '.') AS rd_h) rd_host)`;
}
