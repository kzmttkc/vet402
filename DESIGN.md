# vet402: three visual worlds

Do not mix them. A monochrome home that looks like an RFC, an RFC page that looks like the dashboard, or a dashboard that looks like the landing page is a product error.

## Front page (monochrome)

Neutral greys only (R = G = B). Light and dark follow `prefers-color-scheme`. Inter (`next/font/google`, `--font-inter`) carries words. Fragment Mono (`--font-fragment`, already self-hosted) is only for hosts, transaction strings, and numeric cells in tables. Martian appears on the wordmark in the local top bar only.

Applies to: `/` only. `SiteChrome` hides the shared header and footer on `/` only. This route draws its own two-link bar and footer. Implementation: `src/app/page.tsx`, `src/app/home.module.css`.

First screen: one `h1`, one lede sentence, at most two buttons (buyer and seller), a purchase card from the latest real export row, four counts from the cached state read plus the read time. Lower sections use Live and Coming labels on shipped vs planned capabilities.

### Tokens (`home.module.css`, on `.lp`)

Light default:

| Token | Value |
| --- | --- |
| `--lp-bg` | `#ffffff` |
| `--lp-surface` | `#f7f7f7` |
| `--lp-ink` | `#000000` |
| `--lp-ink-2` | `#333333` |
| `--lp-ink-3` | `#5c5c5c` |
| `--lp-ink-4` | `#6e6e6e` |
| `--lp-rule` | `#dedede` |
| `--lp-rule-soft` | `#ededed` |
| `--lp-btn-bg` | `#000000` |
| `--lp-btn-ink` | `#ffffff` |
| `--lp-focus` | `#000000` |

Dark (`prefers-color-scheme: dark`):

| Token | Value |
| --- | --- |
| `--lp-bg` | `#090909` |
| `--lp-surface` | `rgba(255, 255, 255, 0.03)` |
| `--lp-ink` | `#f7f7f7` |
| `--lp-ink-2` | `#d1d1d1` |
| `--lp-ink-3` | `#a3a3a3` |
| `--lp-ink-4` | `#8f8f8f` |
| `--lp-rule` | `rgba(255, 255, 255, 0.1)` |
| `--lp-rule-soft` | `rgba(255, 255, 255, 0.06)` |
| `--lp-btn-bg` | `#f7f7f7` |
| `--lp-btn-ink` | `#090909` |
| `--lp-focus` | `#f7f7f7` |

Body on `.lp`: `1rem`, line-height `1.6`, letter-spacing `-0.006em`. Type in use: **h1** `clamp(2.375rem, 4.6vw, 3.75rem)` / 600 / 1.02, **lede** `1.1875rem` (mobile `1.0625rem`) / 1.55, **h2** `1.5rem` / 600 / 1.25, **body** `1.0625rem` / 1.65, **labels** `0.8125rem` on facts, record header, table headers, and `readAt`.

Spacing rhythm: wrap padding `24px` (`16px` under `640px`), top bar `64px`, hero gap `72px` and vertical padding `72px 0 56px`, lede offset `24px`, actions `32px` top and `12px` gap, sections `112px` top (`72px` mobile), body under headings `16px`. Radius: record card `14px`, buttons `999px`, focus ring `2px` with offset `3px`.

Motion: one fade, `lpRise` `520ms` `cubic-bezier(0.2, 0.7, 0.2, 1)`, from opacity `0.001` and `translateY(6px)`. `.rise2` adds `90ms` delay. Runs only inside `@media (prefers-reduced-motion: no-preference)`.

### Front page rules

Colours stay R = G = B greyscale with no accent hue. At most two buttons on the first screen. Every displayed count is paired with the time of the state read (`readAt`). The purchase card shows a real row from the public export, never a sample fixture. Mono only on hosts, transactions, and table numbers. Capability rows label shipped work **Live** and planned work **Coming**.

## Public (IETF RFC)

Navy / paper. Martian + Fragment Mono. Running head, sheet, `doc-head`, `doc-title`, `rule-double`, numbered sections. Copy is facts with timestamps.

Applies to: `/memo` (the RFC memo, formerly `/`), observatory, methodology, FAQ, docs, legal, blog, `/payee`, `/agent`, 404s. Not `/`.

2026-11-08 owner decision: the front page was redesigned as a monochrome page. The memo is kept unchanged at `/memo`. 2026-09-02 owner decision: the product's core moved to endpoint verification, so the primary CTA is “Open the observatory” → `/observatory` (event `lp_cta_click`, position `hero_observatory`). The secondary “Read the methodology” and the Abstract copy stay as approved. Payee lookup lives in §4 (“Verified Payee”), not in the hero. 2026-10-21 owner decision: the memo first screen (title, one-line description, seller search, two buttons, three-row table) stays as it is, and “The public ledger” (counts cover the whole ledger, read at `readAt`) and the “Where purchases settled” chain table sit directly under it, drawn from the cached ledger read (`src/components/site/HomeLedger.tsx`). That table replaced the memo’s former §5 “Chains”.

## Operate (dashboard)

Zinc SaaS. Stripe / Linear / Vercel density. Sidebar, cards, forms, live regions on errors. This world stays zinc on purpose.

Applies to: `/dashboard/*` including login.

## Visual direction

Lettering and tokens live in `src/app/globals.css` and the self-hosted fonts. If you need a named Impeccable world, run `/impeccable init` against the shipped public artifact. Do not invent a second brand from a prompt.

## Figures (public world, 2026-09-02)

The RFC world refuses decoration, not information. Measured numbers may be drawn as figures. `Figure N.` caption in the caption voice, paper ground, 1px rules, navy fills. The only functional color is fail / no-receipt in block-ink. Every verdict mark pairs shape with color (filled = pass, crossed = fail, dashed = unverified) so the three values read without color. Components live in `src/components/site/Figures.tsx`. The arithmetic is pure in `src/lib/figures/share.ts`. Do not add pictures, icons, gradients, or charts of things that were not measured.
