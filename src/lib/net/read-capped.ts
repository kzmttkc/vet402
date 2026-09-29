// ============================================================
// 上限つきの本文読み取り（2026-08-22 監査・項目7）。
//
// `(await response.text()).slice(0, N)` は**全部受け取ってから**切り詰める。
// L0/L1 が叩く URL は売り手がカタログに申告した第三者入力なので、敵対的な
// エンドポイントは 1GB のボディを返すだけでサーバレス関数のメモリを食える
// ——切り詰めが走るのはメモリに載せた後だから、上限は何も守っていない。
//
// ここは N バイト受け取った時点でストリームを cancel する。受け取らない
// 意思を相手側にも伝えるので、無駄な転送も止まる。
// ============================================================

/**
 * `response` の本文を最大 `maxBytes` バイトだけ読んで UTF-8 文字列で返す。
 *
 * - 上限に達したらストリームを cancel し、それ以上受け取らない;
 * - `body` を持たない Response（テストのモック等）では従来どおり text() を
 *   読んで切り詰める——**フォールバックは互換のためであって上限の保証では
 *   ない**ので、本番経路（undici の Response）が必ずストリーム側を通ること
 *   が前提;
 * - 切り詰めが UTF-8 の途中で起きた場合、末尾は U+FFFD になる（JSON.parse は
 *   どのみち失敗するので、呼び手の分岐は切り詰め前と変わらない）。
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (maxBytes <= 0) return "";

  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    return (await response.text()).slice(0, maxBytes);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // 上限で抜けた場合も、途中でエラーになった場合も、残りは要らない。
    // cancel 自体の失敗で読めた分を捨てない。
    try {
      await reader.cancel();
    } catch {
      /* already errored/closed */
    }
  }

  const size = Math.min(total, maxBytes);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= size) break;
    const take = Math.min(chunk.byteLength, size - offset);
    merged.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/**
 * readBodyCapped と同じ上限で読み、途中で失敗しても例外にせず、受け取った分と失敗を返す（2026-09-29・L1 の L2）。
 *
 * - `bytes` は**受け取った生のバイト数**（UTF-8 に直す前。上限で抜けたときは最後のチャンクの分だけ maxBytes を超えうる）。
 *   上限を超えたかは `bytes > 上限` で判定する（直した後の文字列の長さは、不正なバイトが U+FFFD になると変わる）;
 * - `text` は先頭 `maxBytes` バイトを UTF-8 に直したもの;
 * - `error` は本文の読み取りの失敗（中断・切断）。無ければ null。失敗の前に受け取った分は `text`・`bytes` に残る。
 */
export async function readBodyCappedDetailed(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; error: unknown | null }> {
  if (maxBytes <= 0) return { text: "", bytes: 0, error: null };
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    try {
      const whole = new Uint8Array(await response.arrayBuffer());
      return { text: new TextDecoder("utf-8").decode(whole.subarray(0, maxBytes)), bytes: whole.byteLength, error: null };
    } catch (error) {
      return { text: "", bytes: 0, error };
    }
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let error: unknown | null = null;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (e) {
    error = e;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already errored/closed */
    }
  }
  const size = Math.min(total, maxBytes);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= size) break;
    const take = Math.min(chunk.byteLength, size - offset);
    merged.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return { text: new TextDecoder("utf-8").decode(merged), bytes: total, error };
}
