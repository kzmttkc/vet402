// Build one day's snapshot from vet402's public export, for the Stellar roots contract.
//   node day.mjs <export.csv> <YYYY-MM-DD> <out.json>
// Rows: every row of https://vet402.com/api/v1/observatory/export.csv whose network is stellar:pubnet and whose
// attempted_at falls on that UTC day, with every column as the export prints it (strings), sorted by purchase_id.
// The export keeps changing (a settle_claimed row later becomes settled), so the snapshot written here is what the
// root covers. The export of a later day is not. The output holds the rows, each row's digest and proof, the root,
// and the day number the contract takes (days since 1970-01-01 UTC).
import { readFileSync, writeFileSync } from "node:fs";
import { digestOf, tree } from "./roots.mjs";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const [, , csvPath, date, outPath] = process.argv;
if (!csvPath || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !outPath) {
  console.error("usage: node day.mjs <export.csv> <YYYY-MM-DD> <out.json>");
  process.exit(2);
}
const [header, ...body] = parseCsv(readFileSync(csvPath, "utf8"));
for (const col of ["network", "attempted_at", "purchase_id"]) {
  if (!header.includes(col)) throw new Error(`the export has no ${col} column`);
}
body.forEach((cells, i) => {
  if (cells.length === 1 && cells[0] === "") return; // a trailing newline
  if (cells.length !== header.length) throw new Error(`export record ${i + 1} has ${cells.length} columns, the header has ${header.length}`);
});
const rows = body
  .filter((cells) => !(cells.length === 1 && cells[0] === ""))
  .map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])))
  .filter((r) => r.network === "stellar:pubnet" && r.attempted_at.slice(0, 10) === date)
  .sort((a, b) => (a.purchase_id < b.purchase_id ? -1 : a.purchase_id > b.purchase_id ? 1 : 0));
if (rows.length === 0) {
  console.error(`no stellar:pubnet rows on ${date}`);
  process.exit(3);
}
const digests = rows.map(digestOf);
const { root, proofs } = tree(digests);
const hex = (b) => b.toString("hex");
const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const out = {
  date,
  day,
  count: rows.length,
  root: hex(root),
  source: "https://vet402.com/api/v1/observatory/export.csv",
  rows: rows.map((row, i) => ({ row, digest: hex(digests[i]), proof: proofs[i].map(hex) })),
};
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ date, day, count: rows.length, root: out.root }));
