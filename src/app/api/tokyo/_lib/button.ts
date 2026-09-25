// ============================================================
// 審査員ボタンの3つの入口（mutate / reset / state）の中身。route.ts は realButtonDeps() を渡すだけ。
//
// 関門（PLAN_v4.3 §3.7.1）:
//   W01 本文は {"to":"10001"} か {"to":"10000"} だけ。他は全部 400 {error:"invalid_body"}（入力を反射しない）
//   W02 chainId は定数。サーバの RPC の getChainId() が違えば 503
//   W03 1日 60 回（ip_rate_limits の1文 upsert）・runtime_flags.tokyo_button_halt・env "1" の保険
//   W04 balance − 0.005 ETH ≥ PRESS_GAS × gasPrice × 3。満たさなければ 503、署名しない
//   W05 mutate の先頭・state（90 秒以上・DB かチェーンがまだ戻っていないときだけ）・reset で ensureReverted
//   W06 書き込みの4点（宛先・node・キー・値）は constants.ts の定数だけ
// 関門で止めた応答は「押せない理由の1行」（message）を持つ。画面はそれをそのまま出す。
// ============================================================
import { formatEther } from "viem";
import { logServerError } from "@/lib/util/log";
import {
  AFTER_WRITE_BUDGET_MS, AMOUNT, BALANCE_FLOOR_WEI, CHAIN_ID, DAILY_CAP, GAS_SAFETY, IP_INTERVAL_MS, KEY, NODE, P_D,
  PRESS_GAS, RESPONSE_DEADLINE_MS, SELLER_D, STATE_REVERT_AFTER_MS, VALUES, W_OP,
} from "./constants";
import { forgetVerified, rememberVerified } from "./cache";
import { readAfterWrite, type VerifyView } from "./check";
import { decideHalt } from "./halt";
import { callerKey } from "./ip";
import { amountOf, ensureReverted, revertLocked, type RevertResult } from "./revert";
import type { ButtonDeps, Hex, MutationRow, ReceiptStatus } from "./types";

type Body = Record<string, unknown>;

const NO_STORE = { "Cache-Control": "no-store" } as const;
const json = (status: number, body: Body) => Response.json(body, { status, headers: NO_STORE });

const MESSAGES = {
  button_disabled: "The judge button is paused by a deployment setting.",
  operator_key_missing: "This deployment has no signing key for the judge button.",
  operator_key_mismatch: "The configured key is not the delegated key W_op, so nothing is signed.",
  halted: "The operator paused the judge button.",
  halt_flag_unreadable: "The pause switch could not be read, so the button stays off.",
  chain_mismatch: `The server's RPC is not Sepolia (${CHAIN_ID}).`,
  chain_unreadable: "The Sepolia RPC did not answer.",
  balance_unreadable: "The balance of the button's key could not be read.",
  state_unavailable: "The button's state table could not be read.",
  daily_cap: `Today's limit of ${DAILY_CAP} presses (UTC day) is used up.`,
  too_fast: `Please wait ${IP_INTERVAL_MS / 1000} seconds between presses.`,
  busy: "Another press is being written right now. Try again in a few seconds.",
  revert_first: "The previous change could not be undone yet, so no new change was made.",
  reverting_first: `The previous change is being put back first. Press again in ${IP_INTERVAL_MS / 1000} seconds.`,
  tx_failed: "The transaction could not be sent.",
  tx_reverted: "The transaction was mined but failed on chain, so the promise did not change.",
  already_reverting: "Someone else is putting 10000 back right now. Reload in a few seconds.",
  resolver_moved: "seller-d.eth no longer uses the button's resolver, so nothing was written.",
} as const;

type ErrorCode = keyof typeof MESSAGES;
const blocker = (error: ErrorCode, extra: Body = {}): Body => ({ error, ...extra, message: MESSAGES[error] });
const fail = (status: number, error: ErrorCode, extra: Body = {}) => json(status, blocker(error, extra));

/** 400 の本文は固定。売り手の文字列も本文も反射しない。 */
const invalidBody = () => json(400, { error: "invalid_body" });

/** 例外の文言には RPC の URL（API キー入り）が混ざりうるので、短い要約だけを残す。 */
function logSafe(context: string, error: unknown): void {
  const e = error as { shortMessage?: unknown; name?: unknown } | null;
  const short = typeof e?.shortMessage === "string" ? e.shortMessage : typeof e?.name === "string" ? e.name : "error";
  logServerError(context, new Error(short.split("\n")[0].replace(/https?:\/\/\S+/g, "<url>").slice(0, 200)));
}

type Side = "on" | "off";

/**
 * 本文は1つのキー "to" と、2値のどちらかだけ。数値型・null・本文なし・他のキー（name / node / resolver /
 * key / value / chainId を含む）は全部 null（= 400）。
 */
export async function parseToBody(request: Request, allowed: readonly Side[]): Promise<Side | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > 64) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "to") return null;
  const to = (parsed as { to: unknown }).to;
  if (to === AMOUNT.on && allowed.includes("on")) return "on";
  if (to === AMOUNT.off && allowed.includes("off")) return "off";
  return null;
}

type Gate = { ok: true; operator: Hex } | { ok: false; status: number; body: Body };

/** 署名の前に通す関門（数えない）。env の停止は呼び手が先に見る。 */
export async function txGates(deps: ButtonDeps): Promise<Gate> {
  const operator = deps.operatorAddress();
  if (!operator) return { ok: false, status: 503, body: blocker("operator_key_missing") };
  if (operator.toLowerCase() !== W_OP.toLowerCase()) return { ok: false, status: 503, body: blocker("operator_key_mismatch") };

  const halt = decideHalt(await deps.readHalt());
  if (halt.halted) {
    // 運用者のメモ（reason）は返さない。止まっていることと、読めなかったことだけを言う。
    return { ok: false, status: 503, body: blocker(halt.source === "row" ? "halted" : "halt_flag_unreadable") };
  }

  let got: number;
  try {
    got = Number(await deps.getChainId());
  } catch (e) {
    logSafe("tokyo.chain", e);
    return { ok: false, status: 503, body: blocker("chain_unreadable") };
  }
  if (got !== CHAIN_ID) return { ok: false, status: 503, body: blocker("chain_mismatch", { expected: CHAIN_ID, got }) };

  let balance: bigint;
  let gasPrice: bigint;
  try {
    [balance, gasPrice] = await Promise.all([deps.getBalance(operator), deps.getGasPrice()]);
  } catch (e) {
    logSafe("tokyo.balance", e);
    return { ok: false, status: 503, body: blocker("balance_unreadable") };
  }
  const need = PRESS_GAS * gasPrice * GAS_SAFETY;
  if (balance - BALANCE_FLOOR_WEI < need) {
    const balanceEth = formatEther(balance);
    const floorEth = formatEther(BALANCE_FLOOR_WEI + need);
    return {
      ok: false,
      status: 503,
      body: {
        error: "balance_below_floor",
        balanceEth,
        floorEth,
        message: `The button's key is low on Sepolia ETH (balance ${balanceEth}, floor ${floorEth}).`,
      },
    };
  }
  return { ok: true, operator };
}

const dayKeyOf = (nowMs: number) => `tokyo-mutate-day:${new Date(nowMs).toISOString().slice(0, 10)}`;
const nextUtcMidnight = (nowMs: number) => {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
};

const REVERT_OK: RevertResult["status"][] = ["clean", "reverted", "superseded"];

/** チェーンか DB の seller-d.eth を動かした戻し結果。 */
const REVERT_WROTE: RevertResult["status"][] = ["reverted", "superseded", "pending"];

/** このプロセスで seller-d.eth を書いたら、検証の使い回しを捨てる（次の /api/tokyo/verify は今のチェーンを読む）。 */
function forgetAfterWrite(revert: RevertResult | null, mutated = false): void {
  if (mutated || (revert && (REVERT_WROTE.includes(revert.status) || (revert.status === "clean" && revert.synced)))) {
    forgetVerified(SELLER_D);
  }
}

/** 戻し結果のうち、tx を送ったもの。 */
function revertTx(revert: RevertResult | null): Hex | null {
  return revert && "tx" in revert ? revert.tx : null;
}

/**
 * mutate / reset の応答に入れる「押した後の seller-d.eth の7段」。使い回しを通さず、最後に送った tx の
 * 受領のブロック以上で読む（受領が無い＝まだ載っていないなら読まずに null）。何も送っていなければ読まない。
 * 読めた結果でこのプロセスの使い回しも置き換える。別のプロセスの使い回しには届かないので、画面はこの値を出す。
 */
async function checkAfterWrite(deps: ButtonDeps, lastTx: Hex | null, startedAt: number): Promise<VerifyView | null> {
  if (!lastTx) return null;
  const minBlock = deps.blockOf(lastTx);
  if (minBlock === null) return null;
  const budget = Math.min(AFTER_WRITE_BUDGET_MS, startedAt + RESPONSE_DEADLINE_MS - deps.now());
  if (budget <= 0) return null;
  const view = await readAfterWrite(() => deps.checkSellerD(), minBlock, budget);
  if (view) rememberVerified(SELLER_D, view);
  return view;
}

/**
 * state の関門だけが使う deps。chainId・残高・gasPrice を STATE_CACHE_MS だけ使い回す。
 * mutate・reset・ensureReverted（署名の判断）には渡さない。
 */
function stateReads(deps: ButtonDeps): ButtonDeps {
  const memo = deps.memo;
  if (!memo) return deps;
  return {
    ...deps,
    getChainId: () => memo("chainId", () => deps.getChainId()),
    getBalance: (address) => memo(`balance:${address.toLowerCase()}`, () => deps.getBalance(address)),
    getGasPrice: () => memo("gasPrice", () => deps.getGasPrice()),
  };
}

/**
 * state が表示と「戻し済みか」の判断に使う seller-d.eth の約束。使い回しの鍵に DB の行（generation・値・last_tx）を
 * 入れるので、どのインスタンスでボタンが書いても行が変わり、次の state は読み直す。
 */
async function readOfferForState(deps: ButtonDeps, row: MutationRow | null): Promise<{ value: string; resolver: Hex | null } | null> {
  const key = row ? `offer:${row.generation}:${row.currentValue}:${row.lastTx ?? ""}` : "offer:no-row";
  try {
    return await (deps.memo ? deps.memo(key, () => deps.readOffer()) : deps.readOffer());
  } catch (e) {
    logSafe("tokyo.state.offer", e);
    return null;
  }
}

type MutateOutcome =
  | { kind: "capped" }
  | { kind: "revert_blocked"; revert: RevertResult }
  | { kind: "reverting_first"; revert: RevertResult }
  | { kind: "tx_failed"; revert: RevertResult }
  | { kind: "reverted_only"; revert: RevertResult }
  | { kind: "mutated"; revert: RevertResult; tx: Hex; receipt: ReceiptStatus; pressesToday: number };

/** POST /api/tokyo/mutate — seller-d.eth の amount を 10000 → 10001（{"to":"10000"} は戻すだけ）。 */
export async function handleMutate(request: Request, deps: ButtonDeps): Promise<Response> {
  const startedAt = deps.now();
  if (deps.envDisabled()) return fail(503, "button_disabled");
  const side = await parseToBody(request, ["on", "off"]);
  if (!side) return invalidBody();

  const gate = await txGates(deps);
  if (!gate.ok) return json(gate.status, gate.body);

  try {
    await deps.store.ensureRow();
    if (side === "on" && !(await deps.store.consumeInterval(`tokyo-mutate-ip:${callerKey(request)}`, IP_INTERVAL_MS))) {
      return fail(429, "too_fast", { retryAfterSeconds: IP_INTERVAL_MS / 1000 });
    }
  } catch (e) {
    logSafe("tokyo.mutate.store", e);
    return fail(503, "state_unavailable");
  }

  let leased: { acquired: true; value: MutateOutcome } | { acquired: false };
  try {
    leased = await deps.withLease<MutateOutcome>(async () => {
      // 前回の変更が残っていれば、先に戻す（W05）。
      const revert = await revertLocked(deps);
      if (!REVERT_OK.includes(revert.status)) return { kind: "revert_blocked", revert };
      if (side === "off") return { kind: "reverted_only", revert };
      // 戻す tx を打ったら、同じ要求で変える tx を続けない（受領待ちを2本直列にすると maxDuration 60 秒を越えうる）。
      if (revertTx(revert)) return { kind: "reverting_first", revert };

      const now = deps.now();
      const pressesToday = await deps.store.consumeDaily(dayKeyOf(now), DAILY_CAP, nextUtcMidnight(now));
      if (pressesToday === null) return { kind: "capped" };

      let tx: Hex;
      try {
        tx = await deps.writeContract({ address: P_D, functionName: "setText", args: [NODE, KEY, VALUES.on] });
      } catch (e) {
        logSafe("tokyo.mutate.write", e);
        return { kind: "tx_failed", revert };
      }
      // 送った直後に記録する（受領を待つ間に落ちても、次の来訪者が戻せるように）。
      await deps.store.recordMutation(tx);
      const receipt = await deps.waitForReceipt(tx);
      if (receipt !== "reverted") await deps.store.appendLog(AMOUNT.off, AMOUNT.on, tx);
      return { kind: "mutated", revert, tx, receipt, pressesToday };
    });
  } catch (e) {
    // tx を送った後に DB の記録で落ちたかもしれない。使い回しを捨ててから返す。
    forgetVerified(SELLER_D);
    logSafe("tokyo.mutate", e);
    return fail(503, "state_unavailable");
  }

  if (!leased.acquired) return fail(409, "busy");
  const o = leased.value;
  forgetAfterWrite("revert" in o ? o.revert : null, o.kind === "mutated");
  switch (o.kind) {
    case "capped":
      return fail(429, "daily_cap", { max: DAILY_CAP });
    case "revert_blocked":
      return fail(409, "revert_first", { revert: o.revert.status });
    case "reverting_first":
      return fail(409, "reverting_first", { revert: o.revert.status, retryAfterSeconds: IP_INTERVAL_MS / 1000 });
    case "tx_failed":
      return fail(502, "tx_failed");
    case "reverted_only":
      return json(200, {
        ok: true,
        status: o.revert.status,
        revert: o.revert,
        check: await checkAfterWrite(deps, revertTx(o.revert), startedAt),
      });
    case "mutated":
      return json(200, {
        ok: true,
        status: o.receipt === "reverted" ? "tx_reverted" : "mutated",
        ...(o.receipt === "reverted" ? { message: MESSAGES.tx_reverted } : {}),
        name: SELLER_D,
        amount: AMOUNT.on,
        tx: o.tx,
        receipt: o.receipt,
        revert: o.revert,
        pressesToday: o.pressesToday,
        dailyMax: DAILY_CAP,
        check: await checkAfterWrite(deps, o.tx, startedAt),
      });
  }
}

/** POST /api/tokyo/reset — 10000 に戻す（時間の条件なし）。本文は {"to":"10000"} だけ。 */
export async function handleReset(request: Request, deps: ButtonDeps): Promise<Response> {
  const startedAt = deps.now();
  if (deps.envDisabled()) return fail(503, "button_disabled");
  const side = await parseToBody(request, ["off"]);
  if (!side) return invalidBody();

  const gate = await txGates(deps);
  if (!gate.ok) return json(gate.status, gate.body);

  let revert: RevertResult;
  try {
    await deps.store.ensureRow();
    revert = await ensureReverted(deps);
    forgetAfterWrite(revert);
  } catch (e) {
    forgetVerified(SELLER_D);
    logSafe("tokyo.reset", e);
    return fail(503, "state_unavailable");
  }
  if (revert.status === "busy") return fail(409, "busy");
  const ok = REVERT_OK.includes(revert.status) || revert.status === "pending";
  const status = revert.status;
  return json(ok ? 200 : 409, {
    ok,
    status,
    revert,
    ...(!ok && status in MESSAGES ? { message: MESSAGES[status as ErrorCode] } : {}),
    check: ok ? await checkAfterWrite(deps, revertTx(revert), startedAt) : null,
  });
}

/** GET /api/tokyo/state — 画面が1発で引く現在値・直前の操作 10 件・押せない理由。 */
export async function handleState(_request: Request, deps: ButtonDeps): Promise<Response> {
  const blockers: Body[] = [];
  let gateOk = false;
  if (deps.envDisabled()) {
    blockers.push(blocker("button_disabled"));
  } else {
    const gate = await txGates(stateReads(deps));
    if (gate.ok) gateOk = true;
    else blockers.push(gate.body);
  }

  let row: MutationRow | null = null;
  try {
    await deps.store.ensureRow();
    row = await deps.store.readRow();
  } catch (e) {
    logSafe("tokyo.state.row", e);
    blockers.push(blocker("state_unavailable"));
  }

  let offer = await readOfferForState(deps, row);

  // W05: 変えてから STATE_REVERT_AFTER_MS 以上たっていれば、描画の前に戻す。
  // ただし DB が戻し済み（current_value = 10000）で、チェーンも VALUES.off（か読めない）なら、リースを取らない。
  // mutated_at は「最後に変えた時刻」のまま残るので、ここで見ないと 90 秒後から毎回リースを取り、
  // その間に押した審査員が 409 busy になる。チェーンが読めないときの revertLocked も clean を返すだけなので同じ答え。
  // DB だけが 10001 のまま（受領待ちの timeout 等）なら ensureReverted が markClean で DB を戻し済みにする。
  let revert: RevertResult | null = null;
  if (gateOk && row) {
    const age = row.mutatedAt ? deps.now() - row.mutatedAt.getTime() : Number.POSITIVE_INFINITY;
    const settled = row.currentValue === AMOUNT.off && (offer === null || offer.value === VALUES.off);
    if (age >= STATE_REVERT_AFTER_MS && !settled) {
      // 署名へ進む前の関門は、使い回した結果でなく、その場でチェーンを読み直す。
      const fresh = await txGates(deps);
      if (!fresh.ok) {
        blockers.push(fresh.body);
      } else {
        try {
          revert = await ensureReverted(deps);
          forgetAfterWrite(revert);
          if (revert.status !== "clean" || revert.synced) {
            row = await deps.store.readRow();
            offer = await readOfferForState(deps, row);
          }
        } catch (e) {
          forgetVerified(SELLER_D);
          logSafe("tokyo.state.revert", e);
        }
      }
    }
  }

  let pressesToday: number | null = null;
  try {
    pressesToday = await deps.store.peekDaily(dayKeyOf(deps.now()));
  } catch {
    pressesToday = null;
  }
  if (pressesToday !== null && pressesToday >= DAILY_CAP) blockers.push(blocker("daily_cap", { max: DAILY_CAP }));

  let log: Awaited<ReturnType<ButtonDeps["store"]["recentLog"]>> = [];
  try {
    log = await deps.store.recentLog(10);
  } catch {
    log = [];
  }

  const raw = offer?.value ?? null;
  const resolver = offer?.resolver ?? null;
  const amount = amountOf(raw);

  return json(200, {
    name: SELLER_D,
    key: KEY,
    amount,
    canonical: raw === VALUES.off,
    changedByButton: raw === VALUES.on,
    resolver,
    expectedResolver: P_D,
    mutatedAt: row?.mutatedAt?.toISOString() ?? null,
    lastTx: row?.lastTx ?? null,
    revertAfterSeconds: STATE_REVERT_AFTER_MS / 1000,
    revert,
    log,
    canPress: blockers.length === 0,
    blockers,
    pressesToday,
    dailyMax: DAILY_CAP,
    operator: W_OP,
  });
}
