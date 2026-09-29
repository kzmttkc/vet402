// ============================================================
// 外向きメール送信（Resend HTTP API）。2026-09-02 敵対的監査 F7: 「取った email に
// 送る手段がない」。ライブラリは足さず、REST 1 本で済ませる。
//
// 未設定（RESEND_API_KEY / MAIL_FROM のどちらかが無い）なら送らず
// { skipped: "mail_unset" } を返し、logServerError で fail-loud にする。
// 呼び手はそれを見て「送っていない」前提で振る舞う（通知の基準判定を進めない等）。
// 宛先アドレスはログに書かない。
// ============================================================
import { logServerErrorSafe } from "@/lib/util/log-safe";

export type MailInput = {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  /** 追加ヘッダ（List-Unsubscribe 等）。2026-09-28 監査: 通知メールに配信停止ヘッダを付けるため。 */
  headers?: Record<string, string>;
};
export type SendResult = { sent: true; id: string } | { sent: false; error: string } | { skipped: "mail_unset" };

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * 2026-09-29 監査4周目: Resend への fetch に期限が無く、Resend が応答を返さないと呼び手
 * （購読の確認・通知の cron）が関数の maxDuration まで止まり、後続の処理ごと落ちていた。
 * 10 秒で打ち切り、{ sent:false, error:"mail_timeout" } を返す（送れたかは不明なので
 * 「送った」とは扱わない）。
 */
export const MAIL_SEND_TIMEOUT_MS = 10_000;

export async function sendMail(input: MailInput, opts: { timeoutMs?: number } = {}): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.MAIL_FROM?.trim();
  if (!key || !from) {
    logServerErrorSafe("mail", new Error("mail_unset: RESEND_API_KEY / MAIL_FROM not set; message not sent"));
    return { skipped: "mail_unset" };
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(opts.timeoutMs ?? MAIL_SEND_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
      }),
    });
    if (!res.ok) {
      const error = `resend_http_${res.status}`;
      logServerErrorSafe("mail", new Error(error));
      return { sent: false, error };
    }
    const json = (await res.json().catch(() => ({}))) as { id?: unknown };
    return { sent: true, id: typeof json.id === "string" ? json.id : "" };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    logServerErrorSafe("mail", timedOut ? new Error("mail_timeout") : error);
    return { sent: false, error: timedOut ? "mail_timeout" : error instanceof Error ? error.message : String(error) };
  }
}
