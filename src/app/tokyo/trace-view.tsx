// 7段の trace の表。ページ（サーバ）と審査員ボタンの欄（クライアント）の両方が使う。フックを持たない。
import type { TraceStep } from "../api/tokyo/_lib/verify";

export type TraceData = {
  name: string;
  ok: boolean;
  reasons: string[];
  block: string;
  blockTimestamp: string;
  amount: string | null;
  trace: TraceStep[];
  ms?: number;
  /** サーバが読み終えた時刻（ISO）。使い回した結果でも読んだ時刻のまま出す。 */
  readAt?: string;
};

const STATUS_LABEL: Record<TraceStep["status"], string> = { ok: "ok", fail: "FAIL", skipped: "skip" };
const STATUS_CLASS: Record<TraceStep["status"], string> = {
  ok: "text-signal",
  fail: "text-block-ink font-semibold",
  skipped: "text-brand-mist",
};

function utc(ts: string): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

export function TraceView({ data, buttonNote }: { data: TraceData; buttonNote?: string | null }) {
  const okSteps = data.trace.filter((s) => s.status === "ok").length;
  return (
    <div className="mt-4">
      <p className="doc-p">
        <strong>{data.name}</strong> at Sepolia block <code>{data.block}</code>
        {utc(data.blockTimestamp) ? ` (${utc(data.blockTimestamp)})` : ""}
        {data.readAt ? `, read at ${data.readAt.slice(11, 19)} UTC` : ""}. Draft format: <code>ensip29-draft</code>.
      </p>
      <p className={`doc-p ${data.ok ? "text-signal" : "text-block-ink"}`}>
        <strong>{data.ok ? "VALID" : "REFUSE"}</strong> {data.ok ? "" : data.reasons.join(", ")} — {okSteps}/7 steps ok
        {data.amount ? ` · offer amount ${data.amount}` : ""}
        {typeof data.ms === "number" ? ` · ${data.ms} ms` : ""}
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-hair text-brand-deep">
              <th className="py-1 pr-3 font-normal">#</th>
              <th className="py-1 pr-3 font-normal">step</th>
              <th className="py-1 pr-3 font-normal">result</th>
              <th className="py-1 font-normal">detail</th>
            </tr>
          </thead>
          <tbody>
            {data.trace.map((s) => (
              <tr key={s.step} className="border-b border-hair align-top" data-step={s.step} data-status={s.status}>
                <td className="py-1 pr-3">{s.step}</td>
                <td className="py-1 pr-3 whitespace-nowrap">{s.name}</td>
                <td className={`py-1 pr-3 ${STATUS_CLASS[s.status]}`}>{STATUS_LABEL[s.status]}</td>
                <td className="py-1 break-all">
                  {Object.entries(s.detail).map(([k, v]) => (
                    <span key={k} className="mr-3 inline-block">
                      <span className="text-brand-mist">{k}=</span>
                      {v}
                    </span>
                  ))}
                  {s.status === "fail" && buttonNote ? (
                    <span className="mt-1 block text-warn-ink">{buttonNote}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
