/**
 * Figures — RFC の紙の世界に置く「データの図」（2026-09-02）。
 *
 * UI/UX 監査の所見: pass / fail は太さの差だけで一覧で目が拾えない、
 * 「10 of 10 settled」は文章でしか無く一目で伝わらない、/observatory は 5 秒で
 * 何をすべきか分からない。ここにある図はすべて**測った数字そのもの**を形にした
 * もので、装飾ではない。RFC にも Figure N はある。
 *
 * 文法（DESIGN.md 公開面）: 紙地・1px 罫・紺の階調。色が意味を運ぶのは fail の
 * block-ink（#9f0712・承認済み色相）だけ。形も同時に変える（塗り／×／破線）ので、
 * 色覚に依らず 3 値が区別できる。アイコン集は使わない——描いているのは判定の記号。
 * すべて SVG の属性で描く（CSS 変更なし。Turbopack のグローバル CSS 事故を避ける）。
 */
import type { ReactNode } from "react";
import { shareSegments, gaugeCells, timelinePositions, funnelWidths, timelineLanes } from "@/lib/figures/share";

export type L0Verdict = "pass" | "fail" | "unverified";

const INK = "#233456";
const INK_MIST = "#8f9cb2";
const HAIR = "#dfe3e9";
const BLOCK = "#9f0712";

/** 判定の記号。pass = 塗りつぶし、fail = × 入りの枠（block-ink）、unverified = 破線の枠。 */
export function VerdictMark({ verdict, size = 10 }: { verdict: L0Verdict; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 10 10", "aria-hidden": true as const, className: "inline-block shrink-0 align-[-0.5px]" };
  if (verdict === "pass") return <svg {...common}><rect x="0.5" y="0.5" width="9" height="9" fill={INK} stroke={INK} /></svg>;
  if (verdict === "fail")
    return (
      <svg {...common}>
        <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke={BLOCK} />
        <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke={BLOCK} strokeWidth="1.25" />
      </svg>
    );
  return <svg {...common}><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke={INK_MIST} strokeDasharray="2 1.5" /></svg>;
}

/** 記号＋判定語。表のセルと doc-head で同じ形にする。 */
export function VerdictWord({ verdict }: { verdict: L0Verdict }) {
  const color = verdict === "pass" ? "text-brand-deep" : verdict === "fail" ? "text-[#9f0712]" : "text-brand-lift";
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${color}`}>
      <VerdictMark verdict={verdict} />
      {verdict}
    </span>
  );
}

function Figure({ n, caption, children }: { n: number; caption: ReactNode; children: ReactNode }) {
  return (
    <figure className="mt-5 max-w-[var(--measure)]">
      {children}
      <figcaption className="mt-2 max-w-[72ch] text-[0.75rem] leading-relaxed text-brand-lift">
        <span className="font-[family-name:var(--font-display)] font-semibold text-brand-deep">Figure {n}.</span> {caption}
      </figcaption>
    </figure>
  );
}

const VERDICT_FILL: Record<L0Verdict, string> = { pass: INK, fail: BLOCK, unverified: HAIR };

/**
 * 判定の積み上げバー。/observatory の表の直上。凡例は件数チップを兼ね、
 * クリックで ?verdict= に絞る（hrefs）。
 *
 * 2026-09-02 デザイン監査 P2: fail 段は最小幅 1.5% を保証するので、実比 0.24% の
 * ときは 7.5 倍に見える。塗りを斜線ハッチにして「実面積ではない」ことを形で言い、
 * 膨らんだ段があるときだけキャプションに注記する。SVG は viewBox を使わず
 * 幅 % で置く——viewBox を横に伸ばすとハッチが歪む。
 */
export function VerdictShareBar({
  n,
  counts,
  hrefs,
  active,
  caption,
  legendExtra,
}: {
  n: number;
  counts: Record<L0Verdict, number>;
  hrefs: Record<L0Verdict, string>;
  active: L0Verdict | null;
  caption: ReactNode;
  /** 凡例の行の末尾に置く追加のリンク（/observatory の [receipts N]）。 */
  legendExtra?: ReactNode;
}) {
  const order: L0Verdict[] = ["pass", "fail", "unverified"];
  const segs = shareSegments(order.map((k) => ({ key: k, n: counts[k] })));
  const offsets = segs.reduce<number[]>((acc, s, i) => [...acc, (acc[i - 1] ?? 0) + (i > 0 ? segs[i - 1].widthPct : 0)], []);
  const inflated = segs.some((s) => s.n > 0 && s.widthPct > s.pct);
  const hatchId = `fig${n}-fail-hatch`;
  return (
    <Figure
      n={n}
      caption={
        <>
          {caption}
          {inflated && <> Bars are proportional; segments under 1.5% are drawn at 1.5%.</>}
        </>
      }
    >
      <svg width="100%" height="10" role="img" aria-label={order.map((k) => `${k} ${counts[k].toLocaleString()}`).join(", ")}>
        <defs>
          <pattern id={hatchId} width="4" height="4" patternUnits="userSpaceOnUse">
            <path d="M-1 1L1 -1M0 4L4 0M3 5L5 3" stroke={BLOCK} strokeWidth="1" />
          </pattern>
        </defs>
        {segs.map((s, i) =>
          s.widthPct > 0 ? (
            <rect
              key={s.key}
              x={`${offsets[i]}%`}
              y="0"
              width={`${s.widthPct}%`}
              height="10"
              fill={s.key === "fail" ? `url(#${hatchId})` : VERDICT_FILL[s.key]}
              stroke={s.key === "fail" ? BLOCK : "none"}
              strokeWidth="1"
            />
          ) : null,
        )}
        <rect x="0" y="0.5" width="100%" height="9" fill="none" stroke={INK} strokeWidth="1" />
      </svg>
      <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[0.8125rem]">
        {segs.map((s) => {
          const isActive = active === s.key;
          return (
            <a
              key={s.key}
              href={hrefs[s.key]}
              aria-current={isActive ? "true" : undefined}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums underline ${isActive ? "text-brand-deep decoration-2" : "text-brand hover:text-brand-deep hover:decoration-2"}`}
            >
              <VerdictMark verdict={s.key} />
              {s.key} {s.n.toLocaleString()}
              <span className="text-brand-lift">({s.pct}%)</span>
            </a>
          );
        })}
        {legendExtra}
      </p>
    </Figure>
  );
}

/** 決済目盛り。1 試行 = 1 目盛り（20 超は比例）。塗り = 受領証あり、× = 受領証なし。 */
export function SettleGauge({ n, settled, attempts, caption }: { n: number; settled: number; attempts: number; caption: ReactNode }) {
  const g = gaugeCells(settled, attempts);
  const cell = 12;
  const gap = 4;
  const w = g.cells.length * (cell + gap) - gap;
  return (
    <Figure n={n} caption={caption}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <svg width={w} height={cell} viewBox={`0 0 ${w} ${cell}`} role="img" aria-label={`${settled} of ${attempts} paid attempts settled`} className="max-w-full">
          {g.cells.map((c, i) => {
            const x = i * (cell + gap);
            return c === "settled" ? (
              <rect key={i} x={x + 0.5} y="0.5" width={cell - 1} height={cell - 1} fill={INK} stroke={INK} />
            ) : (
              <g key={i}>
                <rect x={x + 0.5} y="0.5" width={cell - 1} height={cell - 1} fill="none" stroke={BLOCK} />
                <path d={`M${x + 3} 3L${x + cell - 3} ${cell - 3}M${x + cell - 3} 3L${x + 3} ${cell - 3}`} stroke={BLOCK} strokeWidth="1.25" />
              </g>
            );
          })}
        </svg>
        <span className="font-[family-name:var(--font-display)] text-[0.9375rem] font-semibold tabular-nums text-brand-deep">
          {settled}/{attempts}
        </span>
        {g.scaled && <span className="text-[0.75rem] text-brand-lift">(20 cells, proportional)</span>}
      </div>
    </Figure>
  );
}

/** プローブの時間軸。最初の点から最後の点まで 1 本の線、各プローブを判定の記号で置く。
 *  記号は SVG を伸縮させず HTML で絶対配置する（390px でも記号の大きさが変わらない）。
 *  2026-09-02 P2: 直前の点と幅の 3%（390px の紙面で記号幅 10px 相当）未満なら 1 段下へ置く。 */
const TIMELINE_MIN_GAP = 0.03;
export function ProbeTimeline({ n, probes, caption }: { n: number; probes: readonly { at: Date; verdict: L0Verdict }[]; caption: ReactNode }) {
  const pts = timelinePositions(probes);
  if (pts.length === 0) return null;
  const lanes = timelineLanes(pts.map((p) => p.x), TIMELINE_MIN_GAP);
  const stepped = lanes.some((l) => l === 1);
  const first = pts[0].at.toISOString().slice(0, 10);
  const last = pts[pts.length - 1].at.toISOString().slice(0, 10);
  return (
    <Figure
      n={n}
      caption={
        <>
          {caption}
          {stepped && <> Marks closer than one mark width are stepped down one lane.</>}
        </>
      }
    >
      <div className={`relative mx-[5px] ${stepped ? "h-[34px]" : "h-[22px]"}`} role="img" aria-label={`${pts.length} probes from ${first} to ${last}`}>
        <div className="absolute inset-x-0 top-[10px] h-px bg-brand-lift" />
        {pts.map((p, i) => (
          <span
            key={i}
            className={`absolute ${lanes[i] === 1 ? "top-[19px]" : "top-[5px]"} -ml-[5px] inline-flex bg-paper leading-none`}
            style={{ left: `${(p.x * 100).toFixed(2)}%` }}
            title={`${p.at.toISOString().slice(0, 16).replace("T", " ")} UTC · ${p.verdict}`}
          >
            <VerdictMark verdict={p.verdict} />
          </span>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[0.75rem] tabular-nums text-brand-lift">
        <span>{first}</span>
        {first !== last && <span>{last}</span>}
      </div>
    </Figure>
  );
}

/** 漏斗。段ごとに横棒（先頭比）と実数。LP §4 で「登録 → L0 pass → L1 受領証あり」を 1 枚で示す。 */
export function FunnelFigure({ n, stages, caption }: { n: number; stages: readonly { label: string; n: number; href?: string; verdict?: L0Verdict }[]; caption: ReactNode }) {
  const widths = funnelWidths(stages.map((s) => s.n));
  return (
    <Figure n={n} caption={caption}>
      <div className="flex flex-col gap-2">
        {stages.map((s, i) => (
          <div key={s.label} className="flex items-center gap-3 text-[0.8125rem]">
            <span className="w-[15ch] shrink-0 text-brand sm:w-[28ch]">
              {s.href ? <a href={s.href} className="underline">{s.label}</a> : s.label}
            </span>
            <svg viewBox="0 0 100 10" preserveAspectRatio="none" width="100%" height="10" className="min-w-0 flex-1" aria-hidden="true">
              {/* 2026-09-02 P2: 1 段目の hair 塗りは /observatory の unverified と同色で二義だった。1 段目は枠のみ。 */}
              {i > 0 && widths[i] > 0 && <rect x="0" y="0" width={widths[i]} height="10" fill={INK} />}
              {i === 0 && <rect x="0" y="0" width="100" height="10" fill="none" stroke={INK} strokeWidth="0.3" vectorEffect="non-scaling-stroke" />}
            </svg>
            <span className="w-[7ch] shrink-0 text-right font-[family-name:var(--font-display)] font-semibold tabular-nums text-brand-deep">
              {s.n.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </Figure>
  );
}
