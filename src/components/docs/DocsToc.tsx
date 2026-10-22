"use client";

import { useEffect, useRef, useState } from "react";

export type TocItem = { href: string; label: string; children?: TocItem[] };

/**
 * DocsToc — /docs/api のページ内ナビ。
 *
 * 2026-08-12 ペルソナ監査 FIX-6。実測でこうなっていた（mobile 375px）:
 *   - 目次 6項目に対して実際の見出しは h2/h3 で21個。「Endpoints」1項目の下に
 *     13エンドポイントが畳まれていて、`POST /api/v1/payees/verify` に着くには
 *     #endpoints から追加で 3,059px（3.8画面）スクロールが要った。全長 10,827px。
 *   - 横並びの目次が ul.scrollWidth 468 > clientWidth 343 で、`Availability` と
 *     `Error codes` が画面外。フェードも矢印も無いので「目次は4項目」に見えた。
 *   - 6項目すべて同色・aria-current 無しで、13画面ぶんの文書のどこにいるか
 *     目次から分からない。
 *   - リンクの当たり判定が height 16px（WCAG 2.5.8 の 24×24 未満）。
 *
 * 対応:
 *   - モバイルは <details> の開閉式にして、6セクション＋13エンドポイントを
 *     縦に全部出す。横スクロールを無くしたので「画面外に項目がある」問題自体が
 *     消える（フェードで示すより、隠さないほうが確実）。
 *   - デスクトップは従来どおりの横一列（6項目・幅に収まる）。
 *   - 現在位置は scroll で判定して aria-current="location" と太字を付ける。
 *     IntersectionObserver ではなく素朴なスクロール判定にしているのは、
 *     rootMargin の隙間に入って「どこもハイライトされない」状態を作らないため。
 *   - リンクは py-1.5（>= 24px）で 2.5.8 を満たす。
 */
const HEADER_OFFSET = 128; // sticky header 56 + この目次帯ぶんの余裕（2026-08-13 に h-16 → h-14）

function flatten(items: TocItem[]): TocItem[] {
  return items.flatMap((i) => [i, ...(i.children ?? [])]);
}

export default function DocsToc({ items }: { items: TocItem[] }) {
  const [activeHref, setActiveHref] = useState<string>("");
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const all = flatten(items);
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = "";
      for (const item of all) {
        const el = document.getElementById(item.href.slice(1));
        if (!el) continue;
        if (el.getBoundingClientRect().top - HEADER_OFFSET <= 0) current = item.href;
      }
      // ページ最下部では最後の見出しを現在地にする（残り高さが足りず
      // top が 0 を越えない見出しが取り残されるのを防ぐ）。
      if (window.scrollY + window.innerHeight >= document.body.scrollHeight - 2) {
        const last = all[all.length - 1];
        if (last) current = last.href;
      }
      setActiveHref(current);
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [items]);

  // ページ先頭ではまだどの見出しも越えていない。そこで既定値を出すと
  // 「On this page — On this page」という間の抜けた表示になるので出さない。
  const activeLabel = flatten(items).find((i) => i.href === activeHref)?.label ?? null;

  const linkClass = (href: string, indented: boolean) =>
    [
      "block rounded-[2px] px-2 py-1.5 underline-offset-4 hover:underline",
      indented ? "pl-5 text-[0.75rem]" : "",
      // 現在地は地色ではなく「左の1本罫＋紺のインク」で示す。紙面に灰色の
      // 塗りブロックが乗るとこの世界の文法から外れる。
      href === activeHref
        ? "border-l-2 border-brand-deep bg-ground text-brand-deep"
        : "border-l-2 border-transparent text-brand",
    ]
      .filter(Boolean)
      .join(" ");

  return (
    // 2026-08-13 アクセシビリティ監査 [E2]: 帯を bg-ground/95 + backdrop-blur で
    // 敷いていた。11–12px の目次文字の背後に本文が透けるので、拡大して読んで
    // いる読者には「ピントが合っていない」ようにしか見えない。ここは紙の上に
    // 置いた索引の帯であって、ガラス板ではない。不透明にする（bg-ground は
    // 地色そのものなので、見た目の色は透けていない場所と変わらない）。
    <nav
      aria-label="On this page"
      className="sticky top-14 z-30 border-b border-hair bg-ground px-4 py-2 sm:px-6 md:px-8"
    >
      {/* モバイル: 開閉式の全項目リスト */}
      <details ref={detailsRef} className="mx-auto w-full max-w-[var(--column)] px-[var(--sheet-pad)] md:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-1 text-xs text-brand">
          <span className="truncate">
            On this page
            {activeLabel ? (
              <>
                {" — "}
                <span className="font-semibold text-brand-deep">{activeLabel}</span>
              </>
            ) : null}
          </span>
          <span aria-hidden="true" className="shrink-0 text-brand-lift">
            [+]
          </span>
        </summary>
        {/* 2026-08-13 アクセシビリティ監査 [E2]: max-h-[60vh] は比率なので、
            ビューポートが縮んでも占有率が変わらない。200%拡大の 450px 高の
            画面では sticky ヘッダ 57px + このパネル 315px = 372px、つまり
            画面の 83% が案内に食われ、本文は 78px しか残っていなかった
            （実測）。上限は比率ではなく「本文に必ず残す高さ」から決める:
            16rem = 256px を残す（sticky ヘッダ 57px + この帯の見出し行 +
            本文 約180px）。450px 高では索引が 194px まで縮んで本文が
            180px 残る。もう一方の 20rem = 320px は、背の高い画面で索引が
            伸び続けるのを止める側。 */}
        <ul className="mt-1 max-h-[min(calc(100dvh-16rem),20rem)] overflow-y-auto pb-1 text-xs">
          {items.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                aria-current={item.href === activeHref ? "location" : undefined}
                onClick={() => detailsRef.current && (detailsRef.current.open = false)}
                className={linkClass(item.href, false)}
              >
                {item.label}
              </a>
              {item.children?.length ? (
                <ul>
                  {item.children.map((child) => (
                    <li key={child.href}>
                      <a
                        href={child.href}
                        aria-current={child.href === activeHref ? "location" : undefined}
                        onClick={() => detailsRef.current && (detailsRef.current.open = false)}
                        className={linkClass(child.href, true)}
                      >
                        {child.label}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </details>

      {/* デスクトップ: 横並び。2026-08-13 [M2] で Quickstart が増えて7項目になり、
          scrollWidth 834 > clientWidth 763 で `Error codes` が画面外へ出た
          （overflow-x-auto は「隠れている項目がある」ことを示さないので、
          2026-08-12 にモバイルで直したのと同じ欠陥が desktop 側に再発した）。
          横スクロールをやめて折り返す。項目が増えても隠れない。 */}
      <ul className="mx-auto -mb-1 hidden w-full max-w-[var(--column)] flex-wrap gap-x-2 gap-y-0.5 px-[var(--sheet-pad)] pb-1 text-xs md:flex">
        {items.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              aria-current={item.href === activeHref ? "location" : undefined}
              className={linkClass(item.href, false)}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
