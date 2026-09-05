import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit, PUBLIC_DISCLAIMER } from "@/lib/api/public-route";
import { l2EvidenceOf, loadSellerFacts } from "@/lib/decision/seller-facts";
import { assertEvidenceContract, vet402Evidence } from "@/lib/decision/evidence";
import { getEndpoint } from "@/lib/resolve/lookup";
import { SHA256_HEX_RE } from "@/lib/ids/canonical";
import { UUID_RE } from "@/lib/validation/uuid";
import { logServerError } from "@/lib/util/log";
import type { Evidence, Freshness } from "@/lib/decision/types";

// §9.1: GET /api/v1/observatory/endpoints/{id}/facts — L0–L2 の事実だけ。
// スコアも判定も含めない（§8.3「trustScore を L0–L2 フィールドに入れて返すことを禁止」）。
// id は観測所 uuid でも endpoint_hash（§5）でも受ける。キー不要。
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const gate = await publicRateLimit(request, "endpoint-facts", 120);
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  if (!UUID_RE.test(id) && !SHA256_HEX_RE.test(id)) {
    return NextResponse.json({ error: "invalid_endpoint_id" }, { status: 400, headers: gate.headers });
  }
  try {
    const ref = await getEndpoint(id);
    if (!ref) return NextResponse.json({ error: "not_found" }, { status: 404, headers: gate.headers });
    const loaded = await loadSellerFacts(ref.observatory_id);
    if (!loaded) return NextResponse.json({ error: "not_found" }, { status: 404, headers: gate.headers });
    const { facts, endpoint } = loaded;
    const freshness: Freshness = { l0: facts.l0.observed_at, l1: facts.l1.observed_at, l2: facts.l2.observed_at };
    // /decision と同じ行契約。この面も我々自身の台帳しか読まないので source は vet402。
    const evidence: Evidence[] = [vet402Evidence({ level: "L0", url: `https://vet402.com/observatory/e/${endpoint.id}` })];
    if (facts.l1.last_purchase_id) {
      evidence.push(vet402Evidence({ level: "L1", purchase_id: facts.l1.last_purchase_id, url: `https://vet402.com/api/v1/observatory/endpoints/${endpoint.id}/purchases` }));
    }
    // §6.3 / P1-11: L2 の宣言・応答・差分ハッシュ（mismatch の根拠を第三者が再計算できる）。
    const l2Evidence = l2EvidenceOf(facts, endpoint.id);
    if (l2Evidence) evidence.push(l2Evidence);
    assertEvidenceContract(evidence);
    return NextResponse.json(
      {
        subject: {
          type: "resource",
          id: endpoint.resourceId,
          endpoint_id: endpoint.endpointHash ?? endpoint.id,
          observatory_id: endpoint.id,
          canonical_url: endpoint.canonicalUrl,
          method: endpoint.method,
        },
        facts,
        freshness,
        evidence,
        disclaimer: PUBLIC_DISCLAIMER,
        retrievedAt: new Date().toISOString(),
      },
      { headers: gate.cacheHeaders },
    );
  } catch (error) {
    logServerError("endpoint.facts", error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: gate.headers });
  }
}
