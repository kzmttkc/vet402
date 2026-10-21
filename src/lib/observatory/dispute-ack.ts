// フォーム異議の送信後に、送った人へ返す事実（D-03）。
// 署名付き異議（disputes.ts）は受理と同時に L0 を 1 回測る。ここはフォームの話だけ。
// 文は reprobe-priority.ts の選び方（active・パステンプレート以外・1 回 50 件・1 登録ドメイン 5 件・公開 fail が先・
// 7 日で列から落ちる・直近 60 分に測った出品は次の回）と同じことだけを書く。
// クライアント部品も読むので、DB や drizzle を import しない（パステンプレートの判定は呼び手が渡す）。
import {
  DISPUTE_PRIORITY_DAYS,
  PRIORITY_MIN_PROBE_AGE_MINUTES,
  PRIORITY_PER_DOMAIN,
  REPROBE_PRIORITY_LIMIT,
} from "./reprobe-priority-const";

/** この出品へのフォーム異議が優先の列に入るか。入らないなら、その理由。 */
export type FormDisputeReprobe = "queued" | "not_active" | "path_template";

/** reprobePrioritySql の WHERE（status = 'active' と notPathTemplateSql）と同じ判定。 */
export function formDisputeReprobeOf(input: { status: string; pathTemplate: boolean }): FormDisputeReprobe {
  if (input.status !== "active") return "not_active";
  if (input.pathTemplate) return "path_template";
  return "queued";
}

/** 記録は消えない。どの出品でも言える。 */
export const FORM_DISPUTE_RECORD_STAYS = "The record stays on this page.";

/** 新しいプローブ行は、実行が実際に測ったときだけ足される。 */
export const FORM_DISPUTE_NEW_PROBE = "When a run measures the listing, the new probe is added to its history.";

/**
 * フォーム異議が優先の列でどう扱われるか（active でパステンプレート以外の出品）。
 * 時刻は呼び手が l0ProbeScheduleLabel() で渡す（vercel.json の l0-probe）。
 */
export function formDisputeQueueSentence(scheduleLabel: string, limit: number = REPROBE_PRIORITY_LIMIT): string {
  return [
    `A dispute filed on the record form puts an active listing on a priority list.`,
    `L0 runs probe that list before their ordinary queue, one run at a time.`,
    `A listing whose URL has an unfilled path parameter is not put on that list.`,
    `One run measures up to ${limit} priority listings, at most ${PRIORITY_PER_DOMAIN} from one site.`,
    `Published fails whose catalog declaration changed, or that rest on probes recorded under earlier rules, take places first, and disputes fill the places left.`,
    `A listing probed in the past ${PRIORITY_MIN_PROBE_AGE_MINUTES} minutes waits for a later run.`,
    `A dispute that no run reaches within ${DISPUTE_PRIORITY_DAYS} days leaves the list.`,
    l0ScheduleSentence(scheduleLabel),
  ].join(" ");
}

/** vercel.json の l0-probe の時刻と、それ以外の時刻の L0 実行（c2 など）が先に測りうること。 */
export function l0ScheduleSentence(scheduleLabel: string): string {
  return `The scheduled L0 run is at ${scheduleLabel}, and an L0 run at another time can measure the listing first.`;
}

/** トップの短い版。formDisputeQueueSentence と同じ事実を短く（パステンプレート・60 分・7 日も言う）。 */
export function formDisputeQueueSummary(scheduleLabel: string, limit: number = REPROBE_PRIORITY_LIMIT): string {
  return [
    `A dispute filed on the record form puts an active listing on a priority list that an L0 run probes before its ordinary queue, up to ${limit} a run and ${PRIORITY_PER_DOMAIN} from one site, with published fails that need a re-probe ahead of disputes.`,
    `A listing whose URL has an unfilled path parameter is not put on that list.`,
    `A listing probed in the past ${PRIORITY_MIN_PROBE_AGE_MINUTES} minutes waits for a later run, and a dispute that no run reaches within ${DISPUTE_PRIORITY_DAYS} days leaves the list.`,
    l0ScheduleSentence(scheduleLabel),
  ].join(" ");
}

/** 列に入らない出品の 1 文。測り直さないことと、その理由。 */
export function formDisputeNotQueuedSentence(reprobe: Exclude<FormDisputeReprobe, "queued">): string {
  return reprobe === "not_active"
    ? "This listing is not active in the catalog, so a dispute filed on the record form does not put it on the re-probe list."
    : "This listing's URL has an unfilled path parameter, so vet402 cannot build a request for it and a dispute filed on the record form does not put it on the re-probe list.";
}

/** 記録頁の段落に出す、この出品についての文。 */
export function formDisputeListingSentence(scheduleLabel: string, reprobe: FormDisputeReprobe): string {
  return reprobe === "queued"
    ? `${formDisputeQueueSentence(scheduleLabel)} ${FORM_DISPUTE_RECORD_STAYS} ${FORM_DISPUTE_NEW_PROBE}`
    : `${formDisputeNotQueuedSentence(reprobe)} ${FORM_DISPUTE_RECORD_STAYS}`;
}

/** フォームの送信後表示と、subscribe API の note。同じ文。 */
export function formDisputeAck(scheduleLabel: string, reprobe: FormDisputeReprobe): string {
  return `A person reads this and replies to the address you gave. ${formDisputeListingSentence(scheduleLabel, reprobe)}`;
}

/** 運営者向けの転送メールの段落。公開の文（formDisputeQueueSentence / formDisputeNotQueuedSentence）と同じ事実。 */
export function formDisputeOperatorLine(reprobe: FormDisputeReprobe, scheduleLabel: string): string {
  const facts = reprobe === "queued" ? formDisputeQueueSentence(scheduleLabel) : formDisputeNotQueuedSentence(reprobe);
  return `Records are not deleted on dispute. ${facts} Publish a correction if the record was wrong.`;
}
