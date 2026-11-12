/**
 * Read the decision store and return a CSV of purchases recorded there.
 * The header uses the same column names in the same order as
 * GET /api/v1/observatory/export.csv.
 * vet402 does not receive this CSV.
 * A row is not labeled settled, because vet402 has not read the transfer again on chain.
 */
import { DEFAULT_DECISION_STORE } from "./pay-or-refuse.js";
/**
 * 公開 `/api/v1/observatory/export.csv` の凍結列（export-columns.ts と同じ名前と順番）。
 * ここから足さない。12/12 より前の凍結を超えない。
 */
export const LOCAL_PURCHASE_EXPORT_COLUMNS = [
    "attempted_at",
    "resource_key",
    "network",
    "status",
    "amount_units",
    "spent_units",
    "tx_hash",
    "http_status_paid",
    "latency_ms",
    "l2_schema",
    "held_reason",
    "request_body",
    "request_body_sha256",
    "settlement_source",
    "request_query",
    "request_query_sha256",
    "confirmed_units",
    "purchase_id",
    "l2_reading",
];
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;
const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const SVM_TX = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
/**
 * 公開 CSV の csvCell と同じ規則。式として読まれる先頭には `'` を付け、
 * 引用符と改行を含むセルは二重引用符で囲む。
 */
function csvCell(value) {
    if (value === "")
        return "";
    let text = value;
    if (FORMULA_LEAD.test(text) && !PLAIN_NUMBER.test(text))
        text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonempty(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
/** catalog-source.ts の normalizeResourceKey と同じ。host は小文字、path の大文字は残す。 */
function resourceKeyOf(raw) {
    const trimmed = raw.trim();
    let url;
    try {
        url = new URL(trimmed);
    }
    catch {
        return trimmed;
    }
    const host = url.hostname.toLowerCase();
    const port = url.port ? `:${url.port}` : "";
    let path = url.pathname;
    while (path.endsWith("/"))
        path = path.slice(0, -1);
    return `${host}${port}${path}`;
}
function checkedOf(row) {
    return isRecord(row.payChecked) ? row.payChecked : null;
}
function resultOf(row) {
    const checked = checkedOf(row);
    return checked && isRecord(checked.result) ? checked.result : null;
}
function receiptOf(row) {
    const result = resultOf(row);
    return result && isRecord(result.receipt) ? result.receipt : null;
}
function httpStatus(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599)
        return null;
    return value;
}
function txOf(row) {
    const direct = nonempty(row.txHash);
    if (direct)
        return direct;
    const settlement = receiptOf(row);
    const claim = settlement && isRecord(settlement.settlement) ? nonempty(settlement.settlement.transaction) : null;
    return claim ?? "";
}
function paidAttempt(row) {
    const result = resultOf(row);
    return row.status === "paid" || result?.paid === true;
}
/**
 * 購入の試みだけを出す。署名前の拒否と、支払い前の保留は出さない。
 * 公開 export が budget_denied と in_flight を落とすのと同じ切り方。
 */
function isPurchase(row) {
    const checked = checkedOf(row);
    if (checked?.state === "pending")
        return false;
    if (paidAttempt(row) || row.status === "failed")
        return true;
    if (txOf(row) !== "")
        return true;
    if (httpStatus(receiptOf(row)?.responseStatus) !== null)
        return true;
    return false;
}
function attemptedAt(row) {
    if (typeof row.at === "string") {
        const parsed = new Date(row.at);
        if (!Number.isNaN(parsed.getTime()))
            return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    const atMs = checkedOf(row)?.at;
    if (typeof atMs === "number" && Number.isFinite(atMs))
        return new Date(atMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    return "";
}
function requestUrl(row) {
    return nonempty(row.resource) ?? nonempty(checkedOf(row)?.url) ?? nonempty(receiptOf(row)?.endpoint) ?? "";
}
function networkOf(row) {
    return nonempty(receiptOf(row)?.network) ?? "";
}
function txWellFormed(tx, network) {
    if (tx === "")
        return false;
    if (network.startsWith("eip155:"))
        return EVM_TX.test(tx);
    if (network.startsWith("solana:"))
        return SVM_TX.test(tx);
    return EVM_TX.test(tx) || SVM_TX.test(tx);
}
/**
 * 手元の行はチェーンを読み直していない。settled とは書かない。
 * 売り手の取引 id があるときだけ settle_claimed。形が鎖に合わなければ unverifiable。
 * 200 だけで取引 id が無いときは delivered_no_receipt。それ以外の試みは settle_failed。
 */
function ledgerStatus(row, tx, http, network) {
    if (paidAttempt(row) && tx !== "" && txWellFormed(tx, network))
        return "settle_claimed";
    if (paidAttempt(row) && tx !== "")
        return "settle_claimed_unverifiable";
    if (paidAttempt(row) && http === 200)
        return "delivered_no_receipt";
    return "settle_failed";
}
function unitsOf(row) {
    const amount = nonempty(receiptOf(row)?.amount);
    return amount !== null && /^[0-9]+$/.test(amount) ? amount : "";
}
function requestBodyKind(row) {
    const method = nonempty(receiptOf(row)?.method);
    if (method === null)
        return "";
    return method.toUpperCase() === "POST" ? "" : "none";
}
function toCells(row) {
    const tx = txOf(row);
    const http = httpStatus(receiptOf(row)?.responseStatus);
    const network = networkOf(row);
    const units = unitsOf(row);
    const cells = {
        attempted_at: attemptedAt(row),
        resource_key: resourceKeyOf(requestUrl(row)),
        network,
        status: ledgerStatus(row, tx, http, network),
        amount_units: units,
        spent_units: units,
        tx_hash: tx,
        http_status_paid: http === null ? "" : String(http),
        latency_ms: "",
        l2_schema: "",
        held_reason: "",
        request_body: requestBodyKind(row),
        request_body_sha256: "",
        settlement_source: tx === "" ? "" : "seller_claim",
        request_query: "",
        request_query_sha256: "",
        confirmed_units: "0",
        purchase_id: "",
        l2_reading: "",
    };
    return cells;
}
function headerLine() {
    return `${LOCAL_PURCHASE_EXPORT_COLUMNS.join(",")}\n`;
}
/**
 * 同じ DecisionStore を読む。ファイルは足さない。通信もしない。
 * 店がまだ無いときは見出しだけを返す。
 */
export async function exportLocalPurchaseCsv(options = {}) {
    const path = options.store ?? DEFAULT_DECISION_STORE;
    const { readFile } = await import("node:fs/promises");
    let raw = "";
    try {
        raw = await readFile(path, "utf8");
    }
    catch {
        return headerLine();
    }
    const selected = [];
    let index = 0;
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "")
            continue;
        index += 1;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        if (!isRecord(parsed) || !isPurchase(parsed))
            continue;
        selected.push({ row: parsed, index });
    }
    const ordered = selected
        .map((item) => ({ cells: toCells(item.row), at: attemptedAt(item.row), index: item.index }))
        .sort((left, right) => {
        if (left.at === right.at)
            return left.index - right.index;
        if (left.at === "")
            return 1;
        if (right.at === "")
            return -1;
        return left.at < right.at ? -1 : 1;
    });
    const lines = [LOCAL_PURCHASE_EXPORT_COLUMNS.join(",")];
    for (const item of ordered) {
        lines.push(LOCAL_PURCHASE_EXPORT_COLUMNS.map((column) => csvCell(item.cells[column])).join(","));
    }
    return `${lines.join("\n")}\n`;
}
