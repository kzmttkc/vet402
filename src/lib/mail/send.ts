// ============================================================
// 外向きメール送信（Resend HTTP API）。2026-09-02 敵対的監査 F7: 「取った email に
// 送る手段がない」。ライブラリは足さず、REST 1 本で済ませる。
//
// 未設定（RESEND_API_KEY / MAIL_FROM のどちらかが無い）なら送らず
// { skipped: "mail_unset" } を返し、logServerError で fail-loud にする。
// 呼び手はそれを見て「送っていない」前提で振る舞う（通知の基準判定を進めない等）。
// 宛先アドレスはログに書かない。
// ============================================================
import { logServerError } from "@/lib/util/log";

export type MailInput = { to: string; subject: string; text: string; replyTo?: string };
export type SendResult = { sent: true; id: string } | { sent: false; error: string } | { skipped: "mail_unset" };

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export async function sendMail(input: MailInput): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.MAIL_FROM?.trim();
  if (!key || !from) {
    logServerError("mail", new Error("mail_unset: RESEND_API_KEY / MAIL_FROM not set; message not sent"));
    return { skipped: "mail_unset" };
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const error = `resend_http_${res.status}`;
      logServerError("mail", new Error(error));
      return { sent: false, error };
    }
    const json = (await res.json().catch(() => ({}))) as { id?: unknown };
    return { sent: true, id: typeof json.id === "string" ? json.id : "" };
  } catch (error) {
    logServerError("mail", error);
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}
