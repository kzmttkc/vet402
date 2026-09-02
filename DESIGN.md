# vet402 — two visual worlds

Do not mix these. A public page that looks like the dashboard, or a dashboard that looks like an RFC, is a product error.

## Public (IETF RFC)

Navy / paper. Martian + Fragment Mono. Running head, sheet, `doc-head`, `doc-title`, `rule-double`, numbered sections. Copy is facts with timestamps.

Applies to: the memo, observatory, methodology, FAQ, docs, legal, blog, `/payee`, `/agent`, 404s.

The approved LP memo body and hero (Abstract + two CTAs) are not to be redesigned. 2026-09-02 owner decision: the product's core moved to endpoint verification, so the primary CTA is “Open the observatory” → `/observatory` (event `lp_cta_click`, position `hero_observatory`); the secondary “Read the methodology” and the Abstract copy stay as approved. Payee lookup lives in §4 (“Verified Payee”), not in the hero.

## Operate (dashboard)

Zinc SaaS. Stripe / Linear / Vercel density. Sidebar, cards, forms, live regions on errors. This world stays zinc on purpose.

Applies to: `/dashboard/*` including login.

## Visual direction

Lettering and tokens live in `src/app/globals.css` and the self-hosted fonts. If you need a named Impeccable world, run `/impeccable init` against the shipped public artifact — do not invent a second brand from a prompt.

## Figures (public world, 2026-09-02)

The RFC world refuses decoration, not information. Measured numbers may be drawn as
figures — `Figure N.` caption in the caption voice, paper ground, 1px rules, navy
fills; the only functional color is fail / no-receipt in block-ink. Every verdict
mark pairs shape with color (filled = pass, crossed = fail, dashed = unverified) so
the three values read without color. Components live in
`src/components/site/Figures.tsx`; the arithmetic is pure in `src/lib/figures/share.ts`.
Do not add pictures, icons, gradients, or charts of things that were not measured.
