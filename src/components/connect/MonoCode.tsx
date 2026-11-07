"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "@/app/connect/connect.module.css";

/**
 * /connect のコード見本。docs の CodeBlock と同じ動き（コピー、失敗したら選択、
 * 2 秒で消える読み上げ）で、色はその頁の白黒灰だけを使う。
 */
export default function MonoCode({ code, label }: { code: string; label: string }) {
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
      // clipboard が拒否した。下の選択へ落とす。
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

  const live = state === "copied" ? "Copied" : state === "selected" ? "Selected, press Cmd+C or Ctrl+C" : "";

  return (
    <div className={styles.codeWrap}>
      <pre ref={preRef} tabIndex={0} role="region" aria-label={label} className={styles.code}>
        <code>{code}</code>
      </pre>
      <button type="button" onClick={copy} aria-label="Copy code" className={styles.copy}>
        {state === "idle" ? (
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className={styles.icon}>
            <rect x="7" y="7" width="9" height="9" rx="1.5" />
            <path d="M13 4.5H5.5A1.5 1.5 0 0 0 4 6v7.5" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={styles.icon}>
            <path d="M4 10.5 8 14.5 16 6" />
          </svg>
        )}
      </button>
      <span aria-live="polite" className="sr-only">
        {live}
      </span>
    </div>
  );
}
