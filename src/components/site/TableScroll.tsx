"use client";

import { useEffect, useRef, useState } from "react";

/**
 * TableScroll — the horizontal-scroll container every fact table sits in.
 *
 * 2026-08-13 アクセシビリティ監査（200%拡大・実効CSS幅 720px）。実測でこう
 * なっていた:
 *   - LP §2 の検証レベル表が 720px で 50px、640px で 66px 画面外に出て、
 *     `conform / mismat` `opinion — never m` と語の途中で切れていた。
 *   - `.table-scroll` には boxShadow / maskImage / ::after のいずれも無く、
 *     続きがある手掛かりがゼロだった。
 *   - docs のコードブロックには `role="region"` + `tabindex="0"` +
 *     `aria-label` が付いているのに、表側には3属性とも無い。Chromium は
 *     スクロール可能な要素を自動でフォーカス可能にするが、Safari と
 *     Firefox はしない — つまり両ブラウザではキーボードだけで隠れた列を
 *     読む手段が存在しなかった。同一サイト内で実装が割れていた。
 *
 * ここは3属性を CodeBlock と同じ形で配る1箇所。フェード（スクロール連動
 * シャドウ）は globals.css の .table-scroll 側にある。
 *
 * 2026-09-02 デザイン監査 P1: 表が紙幅 665px を超え、主要列が初期非表示だった
 * （/observatory 1264px、state の By chain は 390px で数値列 0）。
 *   - 先頭列を紙面に貼り付ける（sticky）。globals.css は触らず、Tailwind の
 *     arbitrary variant でこの容器から当てる——Turbopack がグローバル CSS の
 *     変更を落とした事故が 2 回ある。border-collapse の表では sticky セルの
 *     罫線が一緒に動かない（Chromium）ので、下罫は inset shadow で持たせる。
 *   - 右に続きがあるときだけ「→ N more columns」を出す。数えるのは見出しセルの
 *     うち左端が可視域の右端より外にあるもの。端まで送れば消える。
 */
const STICKY_FIRST_COLUMN =
  "[&_.fact-table_th:first-child]:sticky [&_.fact-table_th:first-child]:left-0 [&_.fact-table_th:first-child]:z-[1] [&_.fact-table_th:first-child]:bg-paper [&_.fact-table_th:first-child]:shadow-[inset_0_-1px_0_#233456] " +
  "[&_.fact-table_td:first-child]:sticky [&_.fact-table_td:first-child]:left-0 [&_.fact-table_td:first-child]:z-[1] [&_.fact-table_td:first-child]:bg-paper [&_.fact-table_td:first-child]:shadow-[inset_0_-1px_0_#dfe3e9]";

export function TableScroll({
  label,
  className = "",
  children,
}: {
  /** その表が何の表かを言う。スクリーンリーダのリージョン名になる。 */
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hiddenColumns, setHiddenColumns] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const remaining = el.scrollWidth - el.clientWidth - el.scrollLeft;
      if (remaining <= 1) {
        setHiddenColumns(0);
        return;
      }
      const right = el.getBoundingClientRect().right;
      let n = 0;
      for (const th of el.querySelectorAll("thead th")) {
        if (th.getBoundingClientRect().left >= right - 1) n++;
      }
      setHiddenColumns(Math.max(1, n));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, []);

  return (
    <>
      <div
        ref={ref}
        className={`table-scroll ${STICKY_FIRST_COLUMN} ${className}`.trim()}
        role="region"
        tabIndex={0}
        aria-label={label}
      >
        {children}
      </div>
      <p
        data-table-scroll-hint=""
        hidden={hiddenColumns === 0}
        aria-hidden="true"
        className="doc-caption mt-2 text-right text-brand-lift"
      >
        → {hiddenColumns} more {hiddenColumns === 1 ? "column" : "columns"}
      </p>
    </>
  );
}

export default TableScroll;
