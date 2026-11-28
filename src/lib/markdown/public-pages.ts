import { CHECK_SELLER, GUIDE_UPDATED } from "@/components/site/x402-answers";
import { GLOSSARY } from "@/app/x402/glossary/page";
import { ERC8004_FAQ, ERC8004_PAGE_DESCRIPTION, ERC8004_TERMS } from "@/app/erc-8004/page";
import { INTEGRITY_TERMS, DOES_NOT_TEXT, L1_USER_AGENT } from "@/app/integrity/page";
import { CHECK_SELLER_SECTIONS } from "@/lib/x402/check-a-seller-sections";
import { SELLER_REPUTATION_API, SELLER_REPUTATION_CHECK_FIELDS, SELLER_REPUTATION_API_PUBLISHED } from "@/lib/x402/seller-reputation-sections";
import { TRUST_SCORE_PAGE, TRUST_SCORE_PUBLISHED } from "@/lib/x402/trust-score-sections";
import {
  METHODOLOGY_BLURB,
  METHODOLOGY_H2,
  METHODOLOGY_IN_60,
  METHODOLOGY_TITLE,
} from "@/lib/observatory/methodology-copy";
import {
  OBSERVATORY_VOCABULARY,
  VOCABULARY_GROUP_LABELS,
} from "@/lib/observatory/vocabulary";
import { getObservatoryStatsCached } from "@/lib/observatory/cached-reads";
import { getErc8004MatchCached } from "@/lib/observatory/erc8004-match";
import {
  ERC8004_OBSERVATORY_CHAINS,
  erc8004BaseTotals,
  erc8004HeadlineChainLabel,
  erc8004MatchedFraction,
} from "@/lib/observatory/erc8004-page";
import { ERC8004_INDEXED_CHAIN } from "@/lib/observatory/erc8004-match";
import { publicChainLabel } from "@/lib/observatory/chains";
import { SITE_URL } from "@/lib/site-url";
import { citeAs, DATA_LICENSE_URL } from "@/lib/seo";
import { BUCKET_DOCS, SELLER_CONFIRM_DAYS, ATTRIBUTION_REVIEW_NOTE, type Bucket } from "@/lib/sellers/fix-modes";
import { DECISION_RULES_VERSION } from "@/lib/decision/rules";
import { VERDICT_DOCS } from "@/lib/decision/rules-text";
import {
  STATISTICS_DEFINITIONS as STAT_DEFINITIONS,
  STATISTICS_PAGE_DESCRIPTION as PAGE_DESCRIPTION,
  STATISTICS_PAGE_TITLE as PAGE_TITLE,
} from "@/app/x402/statistics/page";



function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function conditionOf(bucket: Bucket): string {
  const doc = BUCKET_DOCS[bucket];
  const head = `${bucket} (`;
  return doc.startsWith(head) && doc.endsWith(")") ? doc.slice(head.length, -1) : doc;
}

export const BUCKET_ROWS: readonly { bucket: Bucket; counts: string }[] = [
  { bucket: "delivered", counts: "Counts for the seller" },
  { bucket: "pending", counts: "Neither way, until it is known whether money moved" },
  { bucket: "seller", counts: "Counts against the seller" },
  { bucket: "vet402", counts: "Neither way. The failure is vet402's" },
  { bucket: "unsorted", counts: "Neither way" },
  { bucket: "not_bought", counts: "Neither way. It is not a purchase result" },
];

/**
 * Prose copied by hand from the HTML pages (the pages write it inline in JSX).
 * tests/seo-aeo-llmo-h-1127.test.ts checks every sentence against the page source.
 */
export const COPIED_PROSE = {
  glossary:
    "Protocol terms, one line each, with the primary source. Words vet402 uses for its own measurements (L0, L1, L2, delivered, inconclusive) are defined in the methodology.",
  statistics:
    "vet402 buys from public x402 sellers with real money. For each paid request it records whether the transfer settled on-chain and whether the response counted as delivered. The same figures appear on State of x402.",
  erc8004Registration:
    "A registration shows that an agent exists. It does not show that the agent delivers when it is paid. vet402 pays x402 sellers itself and matches each recipient to registered agents, so this page can say how many registered agents have a purchase record.",
  erc8004Registries:
    "ERC-8004 defines an Identity Registry, a Reputation Registry and a Validation Registry. The standard expects each registry to be deployed as a singleton per chain. vet402 reads agent identity on Base, Ethereum and BNB Chain for the match table above.",
} as const;

export const INTEGRITY_ABSTRACT =
  "A buyer relies on vet402 to say what a seller delivered. That is worth relying on when vet402 is held to rules a reader can check. This page lists those rules, each next to the page or the code where it is implemented, and shows how one purchase is sorted and which outcomes count against a seller. It describes how vet402 runs. It does not add to or change the Terms of Service, and where the two differ, the Terms of Service apply.";

export function renderCheckASellerMarkdown(): string {
  const s = CHECK_SELLER;
  const lines = [
    `# ${s.h1}`,
    "",
    ...s.lead.map((p) => p),
    "",
    `## 1. ${CHECK_SELLER_SECTIONS.checkByUrl.title}`,
    CHECK_SELLER_SECTIONS.checkByUrl.body,
    "",
    `## 2. ${CHECK_SELLER_SECTIONS.readDecision.title}`,
    CHECK_SELLER_SECTIONS.readDecision.body,
    "",
    `## 3. ${CHECK_SELLER_SECTIONS.purchaseRecord.title}`,
    CHECK_SELLER_SECTIONS.purchaseRecord.body,
    "",
    `## 4. ${CHECK_SELLER_SECTIONS.compareTerms.title}`,
    CHECK_SELLER_SECTIONS.compareTerms.body,
    "",
    `Canonical HTML: ${SITE_URL}${s.path}`,
    `Updated: ${GUIDE_UPDATED}`,
  ];
  return lines.join("\n");
}

export function renderSellerReputationApiMarkdown(): string {
  const p = SELLER_REPUTATION_API;
  const lines = [
    `# ${p.h1}`,
    "",
    ...p.lead,
    "",
    `## 1. ${p.sections.curl.title}`,
    p.sections.curl.body,
    "",
    `## 2. ${p.sections.fields.title}`,
    p.sections.fields.body,
    "",
    "| Field | Meaning |",
    "| --- | --- |",
    ...SELLER_REPUTATION_CHECK_FIELDS.map((r) => `| ${r.field} | ${r.meaning} |`),
    "",
    `## 3. ${p.sections.decision.title}`,
    p.sections.decision.body,
    "",
    `## 4. ${p.sections.verdicts.title}`,
    `- ALLOW: ${p.sections.verdicts.allow}`,
    `- WARN: ${p.sections.verdicts.warn}`,
    `- BLOCK: ${p.sections.verdicts.block}`,
    "",
    `Canonical HTML: ${SITE_URL}${p.path}`,
    `Updated: ${SELLER_REPUTATION_API_PUBLISHED}`,
  ];
  return lines.join("\n");
}

export async function renderTrustScoreMarkdown(): Promise<string> {
  const p = TRUST_SCORE_PAGE;
  const stats = await getObservatoryStatsCached().catch(() => null);
  const counts =
    stats && stats.l1.attempts > 0 && stats.readAt
      ? `This ledger read: ${fmt(stats.l1.settled)} settled, ${fmt(stats.l1.delivered)} delivered, as of ${stats.readAt.slice(0, 10)} (UTC).`
      : "The ledger could not be read for this rendering, so no counts are shown.";
  const lines = [
    `# x402 trust score`,
    "",
    ...p.lead,
    "",
    `## 1. ${p.sections.discontinued.title}`,
    p.sections.discontinued.body,
    "",
    `## 2. ${p.sections.delivered.title}`,
    p.sections.delivered.body,
    "",
    `## 3. ${p.sections.counts.title}`,
    p.sections.counts.body,
    counts,
    "",
    `## 4. ${p.sections.verify.title}`,
    p.sections.verify.body,
    "",
    `## 5. ${p.sections.window.title}`,
    p.sections.window.body,
    "",
    `Canonical HTML: ${SITE_URL}${p.path}`,
    `Updated: ${TRUST_SCORE_PUBLISHED}`,
  ];
  return lines.join("\n");
}

export function renderGlossaryMarkdown(): string {
  const lines = [
    "# x402 and ERC-8004 glossary",
    "",
    COPIED_PROSE.glossary,
    "",
  ];
  for (const t of GLOSSARY) {
    lines.push(`## ${t.term}`, "", t.text, "", `Source: ${t.source}`, "");
  }
  lines.push(`Canonical HTML: ${SITE_URL}/x402/glossary`);
  return lines.join("\n");
}

export function renderIntegrityMarkdown(): string {
  const lines = [
    "# Integrity Terms",
    "",
    INTEGRITY_ABSTRACT,
    "",
    "## 1. Integrity Terms",
    "",
  ];
  INTEGRITY_TERMS.forEach((t, i) => {
    lines.push(`### 1.${i + 1} ${t.title}`, "", t.text, "");
    lines.push("Source: " + t.sources.map((s) => `${s.label} (${s.href.startsWith("/") ? SITE_URL + s.href : s.href})`).join(" · "));
    lines.push("");
  });
  lines.push(
    "## 2. Failure attribution",
    "",
    `Each purchase row is sorted by one function into one of six outcomes. The decision API, /sellers and /api/v1/sellers/export.csv read the same result. An attempt counts for or against the seller only when it delivered or is on the seller's side. A failure goes on the seller's side only when the row itself shows vet402 was not at fault, and only once such a failure was seen at the listing on ${SELLER_CONFIRM_DAYS} or more different UTC days. The conditions below are the same text as the published rules (${DECISION_RULES_VERSION}).`,
    "",
    "| Outcome | When | Counts against the seller? |",
    "| --- | --- | --- |",
  );
  for (const r of BUCKET_ROWS) {
    lines.push(`| ${r.bucket} | ${conditionOf(r.bucket)} | ${r.counts} |`);
  }
  lines.push("", `An outcome that counts neither way can still keep a check from ALLOW. WARN means: ${VERDICT_DOCS.WARN}`, "", ATTRIBUTION_REVIEW_NOTE, "", "## 3. What vet402 does not do", "", `${DOES_NOT_TEXT} ALLOW, WARN and BLOCK are recommendations to the customer who asked. vet402 does not accept, refuse, delay or reverse anyone's payment. An ALLOW is the fact that the terms vet402 paid were delivered, not a promise about a different recipient or a higher price.`);
  lines.push("", `Every paid purchase carries User-Agent: ${L1_USER_AGENT}.`);
  lines.push("", `Canonical HTML: ${SITE_URL}/integrity`);
  return lines.join("\n");
}

export async function renderStatisticsMarkdown(): Promise<string> {
  const stats = await getObservatoryStatsCached().catch(() => null);
  const live = stats !== null;
  const readAt = stats?.readAt ?? null;
  const answerLead =
    live && stats
      ? `vet402 has attempted ${fmt(stats.l1.attempts)} paid x402 purchases; ${fmt(stats.l1.settled)} settled on-chain and ${fmt(stats.l1.delivered)} came back delivered, as of ${readAt!.slice(0, 10)}.`
      : "The ledger could not be read for this rendering, so no counts are shown.";

  const lines = [
    "# x402 purchase statistics",
    "",
    answerLead,
    "",
    COPIED_PROSE.statistics,
    "",
    "## 1. Headline counts",
    "",
  ];
  if (live && stats) {
    const measures = [
      { key: "l1.attempts", label: "Paid purchase attempts", value: stats.l1.attempts, def: STAT_DEFINITIONS.attempts },
      { key: "l1.settled", label: "Settled", value: stats.l1.settled, def: STAT_DEFINITIONS.settled },
      { key: "l1.delivered", label: "Delivered", value: stats.l1.delivered, def: STAT_DEFINITIONS.delivered },
      {
        key: "l1.settledNotDelivered",
        label: "Settled but not delivered",
        value: stats.l1.settledNotDelivered,
        def: STAT_DEFINITIONS.settledNotDelivered,
      },
      {
        key: "l1.endpointsAttempted",
        label: "Endpoints purchased from",
        value: stats.l1.endpointsAttempted,
        def: STAT_DEFINITIONS.endpointsAttempted,
      },
      {
        key: "l1.endpointsDelivered",
        label: "Endpoints with at least one delivery",
        value: stats.l1.endpointsDelivered,
        def: STAT_DEFINITIONS.endpointsDelivered,
      },
    ];
    lines.push("| Field | Count | Definition |", "| --- | ---: | --- |");
    for (const m of measures) {
      lines.push(`| ${m.key} (${m.label}) | ${fmt(m.value)} | ${m.def} |`);
    }
    if (readAt) {
      lines.push("", `Ledger read at ${readAt}.`);
    }
  } else {
    lines.push("No counts in this read.");
  }
  lines.push("", "## 2. By chain", "", STAT_DEFINITIONS.byChain, "");
  const rows = stats?.l1.byChain ?? [];
  if (live && rows.length > 0) {
    lines.push("| Chain | attempts | settled | delivered |", "| --- | ---: | ---: | ---: |");
    for (const c of rows) {
      lines.push(`| ${c.label || publicChainLabel(c.chain)} | ${fmt(c.attempts)} | ${fmt(c.settled)} | ${fmt(c.delivered)} |`);
    }
  } else {
    lines.push("No chain rows in this read.");
  }
  if (live && readAt) {
    lines.push(
      "",
      citeAs("observatory", `${SITE_URL}/api/v1/observatory/state`, readAt),
      "",
      `Source: ${SITE_URL}/api/v1/observatory/state (${DATA_LICENSE_URL}).`,
    );
  }
  lines.push("", `Page title: ${PAGE_TITLE}`, `Description: ${PAGE_DESCRIPTION}`, `Canonical HTML: ${SITE_URL}/x402/statistics`);
  return lines.join("\n");
}

export async function renderErc8004Markdown(): Promise<string> {
  const match = await getErc8004MatchCached();
  const live = match.status === "ok";
  const lines = [
    "# ERC-8004: agent registries, explained with live payment data",
    "",
    ERC8004_FAQ[0].answer,
    "",
    COPIED_PROSE.erc8004Registration,
    "",
    "## Registered agents whose address matches a payTo vet402 paid",
    "",
  ];
  if (live) {
    const baseFrac = erc8004MatchedFraction(ERC8004_INDEXED_CHAIN, match);
    const baseTotals = erc8004BaseTotals(match);
    if ("fraction" in baseFrac) {
      lines.push(
        `As of ${match.readAt.slice(0, 10)} (UTC), ${baseFrac.fraction} registered ERC-8004 agents on Base have an owner or agentWallet equal to a payTo that vet402 paid over x402.`,
      );
    }
    if (baseTotals) {
      lines.push(
        `Those recipients account for ${fmt(baseTotals.matchedPurchases)} purchase rows, of which ${fmt(baseTotals.matchedSettled)} settled on-chain.`,
      );
    }
    lines.push("", "| Chain | Registered agents scanned | Matched to a payTo vet402 paid |", "| --- | ---: | ---: |");
    for (const chain of ERC8004_OBSERVATORY_CHAINS) {
      const frac = erc8004MatchedFraction(chain, match);
      if ("unavailable" in frac) {
        lines.push(`| ${erc8004HeadlineChainLabel(chain)} | — | Index not readable (${frac.reason}) |`);
      } else {
        lines.push(`| ${erc8004HeadlineChainLabel(chain)} | ${fmt(frac.scanned)} | ${fmt(frac.matched)} |`);
      }
    }
    lines.push("", `Match rule, agent list and purchase counts: ${SITE_URL}/observatory/erc8004. A match is exact lowercase address equality. Names and endpoint URLs are not used.`);
  } else {
    lines.push(`The index could not be read. Match table: ${SITE_URL}/observatory/erc8004. A match is exact lowercase address equality. Names and endpoint URLs are not used.`);
  }
  lines.push(
    "",
    "## The three registries",
    "",
    COPIED_PROSE.erc8004Registries,
    "",
    "## Questions",
    "",
  );
  for (const q of ERC8004_FAQ) {
    lines.push(`### ${q.question}`, "", q.answer, "");
  }
  lines.push("## Terms", "");
  for (const t of ERC8004_TERMS) {
    lines.push(`**${t.term}**: ${t.text}`, "");
  }
  lines.push(
    "## Check one agent",
    "",
    "GET /api/v1/erc8004/check reads one Reputation Registry feedback on Base, fetches its feedbackURI, and re-reads the payment evidence on-chain. It needs no key. The same check is the MCP tool check_8004_agent. API reference: " + `${SITE_URL}/docs/api`,
    "",
    "## Sources",
    "",
    "- https://eips.ethereum.org/EIPS/eip-8004",
    `- ${SITE_URL}/observatory/methodology`,
    `- ${SITE_URL}/x402`,
    "",
    `Description: ${ERC8004_PAGE_DESCRIPTION}`,
    `Canonical HTML: ${SITE_URL}/erc-8004`,
  );
  return lines.join("\n");
}

export function renderMethodologyMarkdown(): string {
  const lines = [
    `# ${METHODOLOGY_TITLE}`,
    "",
    METHODOLOGY_BLURB,
    "",
    `This Markdown is a summary of ${SITE_URL}/observatory/methodology: the section headings, the 60-second summary and the one-line definitions of section 10. The full text of sections 0 to 9 is on the HTML page.`,
    "",
    METHODOLOGY_IN_60,
    "",
    `Chain guides: ${SITE_URL}/x402/chains`,
    "",
  ];
  for (let i = 0; i < METHODOLOGY_H2.length; i++) {
    const title = METHODOLOGY_H2[i]!;
    lines.push(`## ${i}. ${title}`, "");
    if (title === "Definitions, one line each") {
      for (const group of Object.keys(VOCABULARY_GROUP_LABELS) as (keyof typeof VOCABULARY_GROUP_LABELS)[]) {
        lines.push(`### ${VOCABULARY_GROUP_LABELS[group]}`, "");
        for (const t of OBSERVATORY_VOCABULARY.filter((row) => row.group === group)) {
          lines.push(`- **${t.term}**: ${t.definition}`);
        }
        lines.push("");
      }
    } else {
      lines.push(`Full text: ${SITE_URL}/observatory/methodology`);
    }
  }
  lines.push("", `Canonical HTML: ${SITE_URL}/observatory/methodology`);
  return lines.join("\n");
}