"use client";
// 審査員ボタンの欄。現在値は /api/tokyo/state から（そこで 90 秒を過ぎた変更は先に戻る）。
// 押した後は /api/tokyo/verify?name=seller-d.eth を引き直して、同じ7段を見せる。
// 押せないときは理由の1行を出し、ボタンを黙って消さない。
import { useCallback, useEffect, useState } from "react";
import { TraceView, type TraceData } from "./trace-view";

type Blocker = { error: string; message?: string };
type LogRow = { at: string; from: string; to: string; tx: string | null };
type StateData = {
  name: string;
  amount: string | null;
  canonical: boolean;
  changedByButton: boolean;
  mutatedAt: string | null;
  lastTx: string | null;
  revertAfterSeconds: number;
  log: LogRow[];
  canPress: boolean;
  blockers: Blocker[];
  pressesToday: number | null;
  dailyMax: number;
};

const EXPLORER = "https://sepolia.etherscan.io/tx/";
const SIGNER_MISMATCH = "ens_attestation_signer_mismatch";
const NOTE =
  "This red was made by the button. The promise changed from 10000 to 10001, so it no longer matches the signed attestation.";

const STATE_ERROR = "The button's state could not be read. Reload the page to try again.";

async function fetchState(): Promise<StateData | null> {
  try {
    const r = await fetch("/api/tokyo/state", { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as StateData;
  } catch {
    return null;
  }
}

const hhmmss = (iso: string | null) => (iso ? `${iso.slice(11, 19)} UTC` : "");
const short = (tx: string) => `${tx.slice(0, 10)}…${tx.slice(-6)}`;

export function JudgePanel() {
  const [state, setState] = useState<StateData | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [pressing, setPressing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceData | null>(null);

  const loadState = useCallback(async () => {
    const next = await fetchState();
    if (next) {
      setState(next);
      setStateError(null);
    } else {
      setStateError(STATE_ERROR);
    }
  }, []);

  const loadTrace = useCallback(async () => {
    try {
      const r = await fetch("/api/tokyo/verify?name=seller-d.eth", { cache: "no-store" });
      const j = await r.json();
      if (Array.isArray(j?.trace)) setTrace(j as TraceData);
    } catch {
      setTrace(null);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchState().then((next) => {
      if (!alive) return;
      if (next) setState(next);
      else setStateError(STATE_ERROR);
    });
    return () => {
      alive = false;
    };
  }, []);

  const press = async (path: "mutate" | "reset", to: "10001" | "10000") => {
    setPressing(true);
    setNotice(null);
    try {
      const r = await fetch(`/api/tokyo/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string; status?: string };
      if (!r.ok) setNotice(j.message ?? j.error ?? `HTTP ${r.status}`);
      else if (j.status === "pending") setNotice("The transaction is sent and waiting for a block. Reload in a few seconds.");
    } catch {
      setNotice("The request did not reach the server.");
    } finally {
      await loadState();
      await loadTrace();
      setPressing(false);
    }
  };

  if (stateError) return <p className="doc-p text-block-ink">{stateError}</p>;
  if (!state) return <p className="doc-p text-brand-mist">Reading seller-d.eth from Sepolia…</p>;

  const changed = state.changedByButton;
  // 1日の上限は「変える」だけを止める。戻すのは上限に関係なく押せる。
  const resetBlocked = state.blockers.some((b) => b.error !== "daily_cap");
  const failing = trace?.trace.find((s) => s.status === "fail");
  const note = changed && failing && Object.values(failing.detail).includes(SIGNER_MISMATCH) ? NOTE : null;

  return (
    <div>
      <p className="doc-p">
        <code>seller-d.eth</code> <code>x402-offer</code> amount now:{" "}
        <strong className={changed ? "text-block-ink" : "text-signal"}>{state.amount ?? "(not readable)"}</strong>
      </p>

      {changed ? (
        <div className="mt-3 border border-hair p-3" role="status">
          <p className="doc-p text-warn-ink">
            A judge changed one character{state.mutatedAt ? ` at ${hhmmss(state.mutatedAt)}` : ""}.
            {state.lastTx ? (
              <>
                {" "}
                <a className="underline" href={`${EXPLORER}${state.lastTx}`} target="_blank" rel="noopener noreferrer">
                  {short(state.lastTx)}
                </a>
              </>
            ) : null}{" "}
            The next visit after {state.revertAfterSeconds} seconds puts it back, or put it back now.
          </p>
          <button
            type="button"
            className="mt-2 border border-brand-deep px-3 py-1 text-brand-deep disabled:opacity-50"
            disabled={pressing || resetBlocked}
            onClick={() => void press("reset", "10000")}
          >
            Put 10000 back
          </button>
        </div>
      ) : (
        <p className="doc-p text-brand">
          Unchanged: this is the promise the attestation signed.
        </p>
      )}

      {!changed ? (
        <button
          type="button"
          className="mt-3 border border-brand-deep px-3 py-1 text-brand-deep disabled:opacity-50"
          disabled={pressing || !state.canPress}
          onClick={() => void press("mutate", "10001")}
        >
          {pressing ? "Writing to Sepolia…" : "Change one character: 10000 → 10001"}
        </button>
      ) : null}

      {state.blockers.map((b) => (
        <p key={b.error} className="doc-p text-warn-ink" data-blocker={b.error}>
          Cannot press now: {b.message ?? b.error}
        </p>
      ))}
      {notice ? <p className="doc-p text-warn-ink">{notice}</p> : null}
      {state.pressesToday !== null ? (
        <p className="doc-p text-brand-mist">
          Presses today (UTC): {state.pressesToday} of {state.dailyMax}.
        </p>
      ) : null}

      {trace ? (
        <>
          <p className="doc-p mt-4 text-brand-deep">The same seven steps on seller-d.eth, read after your press:</p>
          <TraceView data={trace} buttonNote={note} />
        </>
      ) : null}

      <p className="doc-p mt-4 text-brand-deep">Last 10 changes (who pressed is not recorded):</p>
      {state.log.length === 0 ? (
        <p className="doc-p text-brand-mist">No changes yet.</p>
      ) : (
        <ul className="doc-p list-none pl-0 text-sm">
          {state.log.map((l, i) => (
            <li key={`${l.at}-${i}`}>
              {l.at.replace("T", " ").slice(0, 19)} UTC · {l.from} → {l.to}
              {l.tx ? (
                <>
                  {" · "}
                  <a className="underline" href={`${EXPLORER}${l.tx}`} target="_blank" rel="noopener noreferrer">
                    {short(l.tx)}
                  </a>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
