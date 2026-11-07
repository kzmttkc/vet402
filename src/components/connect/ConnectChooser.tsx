"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import MonoCode from "@/components/connect/MonoCode";
import type { ConnectChoice } from "@/lib/connect/snippets";
import styles from "@/app/connect/connect.module.css";

/**
 * /connect のひとつの選択（I buy / I sell / Both）。WAI-ARIA の tabs パターン:
 * 矢印キーで移動、Home / End で端へ。パネルは全部 DOM に置き、選ばれていないものは hidden
 * （JS が動かない読み手とクローラにも全部のスニペットが届く）。色は黒・白・灰だけ。
 */
export default function ConnectChooser({ choices, signupHref }: { choices: ConnectChoice[]; signupHref: string }) {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const last = choices.length - 1;
    const next =
      e.key === "ArrowRight" ? (active === last ? 0 : active + 1)
      : e.key === "ArrowLeft" ? (active === 0 ? last : active - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <div className={styles.chooser}>
      <div role="tablist" aria-label="Choose your side" className={styles.tablist}>
        {choices.map((c, i) => (
          <button
            key={c.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`connect-tab-${c.id}`}
            aria-selected={i === active}
            aria-controls={`connect-panel-${c.id}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            onKeyDown={onKey}
            className={styles.tab}
          >
            {c.label}
          </button>
        ))}
      </div>

      {choices.map((c, i) => (
        <div
          key={c.id}
          role="tabpanel"
          id={`connect-panel-${c.id}`}
          aria-labelledby={`connect-tab-${c.id}`}
          hidden={i !== active}
          className={styles.panel}
        >
          <p className={styles.summary}>{c.summary}</p>

          <ol className={styles.steps}>
            <li>
              <span className={styles.mark}>1.</span> {c.steps[0]}{" "}
              <Link href={signupHref} className={styles.link}>
                Get a key
              </Link>
            </li>
            <li>
              <span className={styles.mark}>2.</span> {c.steps[1]}
            </li>
            <li>
              <span className={styles.mark}>3.</span> {c.steps[2]}
            </li>
          </ol>

          {c.switchTo ? (
            <div className={styles.switches}>
              {c.switchTo.map((id) => {
                const j = choices.findIndex((x) => x.id === id);
                return (
                  <button
                    key={id}
                    type="button"
                    className={styles.switchBtn}
                    aria-controls={`connect-panel-${id}`}
                    onClick={() => {
                      setActive(j);
                      tabs.current[j]?.focus();
                    }}
                  >
                    Open {choices[j].label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {c.stacks.map((s) => (
            <section key={`${c.id}-${s.stack}`} className={styles.stack}>
              <h2 className={styles.stackHeading}>{s.stack}</h2>
              <p className={styles.intro}>{s.intro}</p>
              <MonoCode label={`${c.label}: ${s.stack}`} code={s.code} />
            </section>
          ))}

          {c.note ? (
            <section className={styles.note}>
              <h2 className={styles.stackHeading}>What each side reads</h2>
              <p className={styles.noteText}>{c.note}</p>
            </section>
          ) : null}
        </div>
      ))}
    </div>
  );
}
