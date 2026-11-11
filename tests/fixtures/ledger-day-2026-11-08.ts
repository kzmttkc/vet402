// ============================================================
// 台帳の 1 日（2026-11-08）の固定値（2026-11-11 3.8 の 6c-1 と 6c-4）。
//
// 根と指紋は、製品のコードを使わずに Python の hashlib で別に計算して、ここに書いた。
//   payload(day, rows) = json.dumps({"v":1,"day":day,"rows":rows}, separators=(",",":"))
//   root(prev, p)      = sha256(((prev or "genesis") + "\n" + p).encode()).hexdigest()
//   ROOT_1107 = root(None, payload("2026-11-07", []))
//   ROOT_1108 = root(ROOT_1107, payload("2026-11-08", [ROW_1, ROW_2]))
//   ROOT_1109 = root(ROOT_1108, payload("2026-11-09", []))
//   ROW_1_FINGERPRINT = sha256(json.dumps(ROW_1, separators=(",",":")))
// 試験が同じ関数を両側にかけて一致させることはしない。
// ============================================================
import type { FakeAnchorRow, FakeL1Row } from "../helpers/observatory-fake-db";

export const ROW_1: FakeL1Row = {
  id: "0b9f5a8e-0000-4000-8000-000000000001",
  endpoint_id: "e1000000-0000-4000-8000-000000000001",
  attempted_at: "2026-11-08T12:02:00.000000Z",
  status: "settled",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  pay_to: "0x1111111111111111111111111111111111111111",
  amount_units: "10000",
  spent_units: "10000",
  payer: "0x2222222222222222222222222222222222222222",
  tx_hash: "0xabababababababababababababababababababababababababababababababab",
  http_status_paid: 200,
  latency_ms: 412,
  l2_schema: "match",
};

export const ROW_2: FakeL1Row = {
  id: "0b9f5a8e-0000-4000-8000-000000000002",
  endpoint_id: "e1000000-0000-4000-8000-000000000002",
  attempted_at: "2026-11-08T18:30:00.000000Z",
  status: "settle_failed",
  network: "eip155:42161",
  asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  pay_to: "0x3333333333333333333333333333333333333333",
  amount_units: "5000",
  spent_units: null,
  payer: "0x2222222222222222222222222222222222222222",
  tx_hash: null,
  http_status_paid: null,
  latency_ms: null,
  l2_schema: null,
};

export const ROOT_1107 = "445cd7212a1ffc8da831938bfde84d62a008865eb568c649d30e3bfc3bf702ec";
export const ROOT_1108 = "888c48d32291e75633fd293c50a7a5e42c3a2e0f9074ea52a9cae9075921ea2d";
export const ROOT_1109 = "940e26c267a3393141033066e123ee4fabe6bf44a9187af3293ae670e9259445";
export const ROW_1_FINGERPRINT = "df6e56583af487c41235b9f422f7c8d5663250b734087d73e0046de838777cd7";

/** その日の公開ファイル（/anchors/day?day=2026-11-08）が返すべきバイト列。 */
export const FILE_1108 =
  '{"v":1,"day":"2026-11-08","rows":[{"id":"0b9f5a8e-0000-4000-8000-000000000001","endpoint_id":"e1000000-0000-4000-8000-000000000001","attempted_at":"2026-11-08T12:02:00.000000Z","status":"settled","network":"eip155:8453","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","pay_to":"0x1111111111111111111111111111111111111111","amount_units":"10000","spent_units":"10000","payer":"0x2222222222222222222222222222222222222222","tx_hash":"0xabababababababababababababababababababababababababababababababab","http_status_paid":200,"latency_ms":412,"l2_schema":"match"},{"id":"0b9f5a8e-0000-4000-8000-000000000002","endpoint_id":"e1000000-0000-4000-8000-000000000002","attempted_at":"2026-11-08T18:30:00.000000Z","status":"settle_failed","network":"eip155:42161","asset":"0xaf88d065e77c8cC2239327C5EDb3A432268e5831","pay_to":"0x3333333333333333333333333333333333333333","amount_units":"5000","spent_units":null,"payer":"0x2222222222222222222222222222222222222222","tx_hash":null,"http_status_paid":null,"latency_ms":null,"l2_schema":null}]}';

/** 11/07・11/08・11/09 の 3 日を封印した表。11/09 の prev_root が 11/08 の根（鎖の値）。 */
export function sealedAnchors(): FakeAnchorRow[] {
  return [
    { day: "2026-11-07", root_hash: ROOT_1107, prev_root: null, entry_count: 0, anchored_tx: null },
    { day: "2026-11-08", root_hash: ROOT_1108, prev_root: ROOT_1107, entry_count: 2, anchored_tx: null },
    { day: "2026-11-09", root_hash: ROOT_1109, prev_root: ROOT_1108, entry_count: 0, anchored_tx: null },
  ];
}

export const freshRows = (): FakeL1Row[] => [{ ...ROW_1 }, { ...ROW_2 }];
