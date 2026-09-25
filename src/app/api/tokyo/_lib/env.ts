// ============================================================
// 審査員ボタン（mutate / reset / state）が読む env は、ここと rpc-env.ts と
// db/client の DATABASE_URL だけ（W01・許可リスト4つと完全一致）。
// 値は外へ出さない。鍵の値は返さず、アドレスへ変えるのは deps.ts だけ。
// ============================================================

/** W_op の秘密鍵。無い・形が違う → null（どちらも「押せない」に倒す。値は表示しない）。 */
export function readOperatorKey(): `0x${string}` | null {
  const raw = process.env.TOKYO_OPERATOR_PRIVATE_KEY;
  if (!raw) return null;
  const k = raw.trim();
  return /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as `0x${string}`) : null;
}

/** 保険の停止。止めに使うのは "1" の1値だけ（"0"・空・未設定は通る）。効くのは再デプロイの後。 */
export function envButtonDisabled(): boolean {
  return process.env.TOKYO_JUDGE_BUTTON_DISABLED === "1";
}
