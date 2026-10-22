/**
 * Figure: where the proof stops in an x402 purchase. Drawn in the RFC figure grammar
 * (monospace labels, 1px navy rules, lifelines in the rule ink). It shows the protocol's
 * steps, not a measurement, so it carries no number.
 *
 * Shape and color both carry the meaning (DESIGN.md, Figures): the step that leaves a
 * transaction is a solid line, the response is dashed (unverified) and its note is in
 * block-ink (no receipt).
 */

const NAVY = "#233456";
const MID = "#3e537c";
const FOG = "#8f9cb2";
const BLOCK = "#9f0712";

type Props = { id: string; className?: string; compact?: boolean };

export function GapFigure({ id, className = "", compact = false }: Props) {
  const ax = 36;
  const px = 262;
  const cx = 444;
  const top = 46;
  const rows = compact ? [72, 110, 148, 186, 252] : [78, 120, 162, 204, 274];
  const bottom = rows[4] + (compact ? 34 : 40);
  const h = bottom + 6;
  const arrow = `${id}-head`;
  const label = (x: number, y: number, text: string, opts: { fill?: string; anchor?: "start" | "middle" | "end"; weight?: number } = {}) => (
    <text
      x={x}
      y={y}
      fill={opts.fill ?? MID}
      fontSize={15}
      fontWeight={opts.weight ?? 400}
      textAnchor={opts.anchor ?? "middle"}
      style={{ fontFamily: "var(--font-fragment), ui-monospace, monospace" }}
    >
      {text}
    </text>
  );
  const box = (x: number, w: number, text: string) => (
    <g>
      <rect x={x - w / 2} y={8} width={w} height={30} fill="#ffffff" stroke={NAVY} strokeWidth={1} />
      <text
        x={x}
        y={28}
        fill={NAVY}
        fontSize={13.5}
        fontWeight={600}
        textAnchor="middle"
        style={{ fontFamily: "var(--font-martian), ui-monospace, monospace" }}
      >
        {text}
      </text>
    </g>
  );
  const msg = (n: number, from: number, to: number, y: number, dashed = false, color = NAVY) => (
    <line
      className={`gap-line gap-line-${n}`}
      pathLength={dashed ? undefined : 1}
      x1={from}
      y1={y}
      x2={to + (to > from ? -2 : 2)}
      y2={y}
      stroke={color}
      strokeWidth={1.25}
      strokeDasharray={dashed ? "5 5" : undefined}
      markerEnd={`url(#${arrow}-${color.slice(1)})`}
    />
  );
  return (
    <svg
      viewBox={`0 0 480 ${h}`}
      role="img"
      aria-labelledby={`${id}-t ${id}-d`}
      className={`h-auto w-full ${className}`}
    >
      <title id={`${id}-t`}>Where the proof stops in an x402 purchase</title>
      <desc id={`${id}-d`}>
        The agent sends a request. The API answers 402 Payment Required. The agent retries with payment. The API settles
        the payment on chain, which leaves a transaction. The API sends a response, which leaves no proof anywhere.
      </desc>
      <defs>
        {[NAVY, BLOCK].map((c) => (
          <marker
            key={c}
            id={`${arrow}-${c.slice(1)}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M1 1 L9 5 L1 9" fill="none" stroke={c} strokeWidth={1.4} />
          </marker>
        ))}
      </defs>
      {[ax, px, cx].map((x) => (
        <line key={x} x1={x} y1={top} x2={x} y2={bottom} stroke={FOG} strokeWidth={1} />
      ))}
      {box(ax, 64, "Agent")}
      {box(px, 112, "x402 API")}
      {box(cx, 64, "Chain")}

      {label((ax + px) / 2, rows[0] - 8, "1  request")}
      {msg(1, ax, px, rows[0])}
      {label((ax + px) / 2, rows[1] - 8, "2  402 Payment Required")}
      {msg(2, px, ax, rows[1])}
      {label((ax + px) / 2, rows[2] - 8, "3  retry, paid")}
      {msg(3, ax, px, rows[2])}
      {label((px + cx) / 2, rows[3] - 8, "4  settle")}
      {msg(4, px, cx, rows[3])}
      {label(cx - 8, rows[3] + 22, "tx on chain", { anchor: "end", fill: NAVY })}
      {label(cx - 8, rows[3] + 41, "proof of payment", { anchor: "end", fill: NAVY })}
      {label((ax + px) / 2, rows[4] - 8, "5  response ?")}
      {msg(5, px, ax, rows[4], true, BLOCK)}
      {label(ax + 8, rows[4] + 24, "proof of delivery: none", { anchor: "start", fill: BLOCK })}
    </svg>
  );
}
