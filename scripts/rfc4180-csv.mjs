/** RFC 4180: quoted cells may hold commas, quotes ("") and newlines. */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

export function parseCsvRecords(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])));
}

export function readCsvSync(path, readFileSync) {
  return parseCsvRecords(readFileSync(path, "utf8"));
}