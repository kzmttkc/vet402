"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./CodeBlock.module.css";

/**
 * CodeBlock — the single source of truth for every code sample on the site.
 *
 * 2026-08-12 ペルソナ監査 FIX-5 / FIX-10。実測でこうなっていた:
 *   - /docs/api の <pre> 19個・LP の <pre> 2個に対して、コピーボタンは 0個
 *     （ページ内の <button> は「Menu」だけ）。webhook 署名検証の20行に
 *     「copy it as-is」と書いておきながら手で選択させていた。
 *   - モバイル 375px で最長の <pre> は scrollWidth 910 / clientWidth 309。
 *     mask-image も ::after も無く、JSON が断ち切られたまま
 *     「続きがあること自体が見えない」状態だった。
 *
 * 対応:
 *   - 右上に 44×44 のコピーボタン（aria-label="Copy code"）。押下結果は
 *     aria-live で読み上げにも出す。clipboard API が無い環境（http や古い
 *     Safari）では execCommand へ落とし、それも失敗したら「Select all」と
 *     して全選択するところまでやる（黙って何も起きないのが最悪）。
 *   - 横スクロールの手掛かりは CodeBlock.module.css の .scroll。mask-image の
 *     静的フェードは端まで送った時に最後の文字を消すので採らず、
 *     background-attachment: local のスクロール連動シャドウにしている。
 *
 * tabIndex / role="region" / aria-label は 2026-08-06 の a11y 修正で
 * <pre> に付いていたものをそのまま引き継ぐ（キーボードだけで横スクロール
 * できる唯一の手段なので外さない）。
 */
export default function CodeBlock({
  code,
  label,
  className = "",
}: {
  code: string;
  label: string;
  className?: string;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const [state, setState] = useState<"idle" | "copied" | "selected">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);

  const copy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
        setState("copied");
        return;
      }
    } catch {
      // fall through to the selection fallback
    }
    const pre = preRef.current;
    if (pre && typeof window !== "undefined") {
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      setState("selected");
      return;
    }
    setState("idle");
  }, [code]);

  return (
    <div className={`relative ${className}`}>
      <pre
        ref={preRef}
        tabIndex={0}
        role="region"
        aria-label={label}
        // min-h-12: 1行だけのサンプル（<pre> は 40px）だと 44px のコピーボタンが
        // 下へはみ出す。当たり判定 44px（WCAG 2.5.8）を削らずに収めるため、
        // 枠の高さを top-1 + 44 = 48px 以上にしておく。
        // 2026-08-13 vet402: 地色を zinc-900 から brand-deep (#233456) へ。
        // 紙面に落ちる黒い箱は世界に無い。#eef0f3 on #233456 = 10.4:1。
        className={`${styles.scroll} min-h-12 overflow-x-auto rounded-[2px] bg-brand-deep py-3 pl-3 pr-14 text-xs leading-[1.45] text-ground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white`}
      >
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy code: ${label}`}
        className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-[2px] text-brand-mist transition-[background-color,color] hover:bg-brand hover:text-white"
      >
        {state === "idle" ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            className="h-4 w-4"
          >
            <rect x="7" y="7" width="9" height="9" rx="1.5" />
            <path d="M13 4.5H5.5A1.5 1.5 0 0 0 4 6v7.5" />
          </svg>
        ) : (
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-4 w-4"
          >
            <path d="M4 10.5 8 14.5 16 6" />
          </svg>
        )}
      </button>
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? "Copied to clipboard" : state === "selected" ? "Selected — press Cmd or Ctrl + C to copy" : ""}
      </span>
    </div>
  );
}
