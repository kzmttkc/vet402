// ============================================================
// Vouch — webhook pure logic: SSRF guard + signature scheme.
//
// Two properties, both security-critical:
//   1. isSafeWebhookUrl is the only thing between "authenticated customer
//      registers a URL" and "our server POSTs to it" — the classic pivot
//      into cloud metadata services and internal hosts.
//   2. The signature is what lets a receiver trust that a delivery came from
//      us and is not a replay. Sign/verify must round-trip, and verify must
//      reject tampering, key mismatch, and stale timestamps.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSafeWebhookUrl,
  isPublicUnicastIp,
  resolveDeliveryTarget,
  isWebhookEvent,
  generateWebhookSecret,
  signWebhookPayload,
  verifyWebhookSignature,
  sealWebhookSecret,
  openWebhookSecret,
  WEBHOOK_EVENTS,
} from "@/lib/webhooks";

// ---- SSRF guard ------------------------------------------------------------

test("https to a public hostname is allowed", () => {
  assert.equal(isSafeWebhookUrl("https://example.com/hooks/vouch"), true);
  assert.equal(isSafeWebhookUrl("https://api.partner.io:8443/wh?x=1"), true);
});

test("plain http is refused — the payload carries customer signal data", () => {
  assert.equal(isSafeWebhookUrl("http://example.com/hook"), false);
});

test("every classic SSRF pivot is refused", () => {
  const attacks = [
    "https://localhost/hook",
    "https://foo.localhost/hook",
    "https://127.0.0.1/hook",
    "https://0.0.0.0/hook",
    "https://10.1.2.3/hook",
    "https://192.168.1.1/hook",
    "https://172.16.0.1/hook",
    "https://172.31.255.255/hook",
    "https://169.254.169.254/latest/meta-data/", // AWS metadata
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://100.64.0.1/hook", // CGNAT
    "https://224.0.0.1/hook", // multicast
    "https://[::1]/hook",
    "https://intranet/hook", // bare single-label name
    "https://user:pass@example.com/hook", // embedded credentials
    "ftp://example.com/hook",
    "file:///etc/passwd",
    "not a url",
  ];
  for (const url of attacks) {
    assert.equal(isSafeWebhookUrl(url), false, `must refuse ${url}`);
  }
});

test("172.x outside the private /12 stays allowed", () => {
  assert.equal(isSafeWebhookUrl("https://172.15.0.1/hook"), true);
  assert.equal(isSafeWebhookUrl("https://172.32.0.1/hook"), true);
});

// ---- delivery-time SSRF pin (DNS-rebinding) --------------------------------
//
// The string guard cannot see what a public hostname resolves to. These prove
// the second layer: the IP classifier rejects every non-public range, and the
// delivery-target resolver refuses a hostname that resolves (even partly) into
// one — which is exactly what a rebinding attacker flips a public name into.

test("isPublicUnicastIp rejects every non-public IPv4 range", () => {
  const priv = [
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254", // AWS/GCP metadata
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1", // CGNAT
    "224.0.0.1", // multicast
    "255.255.255.255", // broadcast
  ];
  for (const ip of priv) assert.equal(isPublicUnicastIp(ip), false, `must reject ${ip}`);
});

test("isPublicUnicastIp allows genuinely public IPv4", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "203.0.200.5", "172.15.0.1", "172.32.0.1"]) {
    assert.equal(isPublicUnicastIp(ip), true, `must allow ${ip}`);
  }
});

test("isPublicUnicastIp rejects non-public IPv6 (incl. mapped v4) and junk", () => {
  const bad = [
    "::1", // loopback
    "::", // unspecified
    "fe80::1", // link-local
    "fc00::1", // ULA
    "fd12:3456::1", // ULA
    "ff02::1", // multicast
    "::ffff:169.254.169.254", // IPv4-mapped metadata
    "::ffff:10.0.0.1", // IPv4-mapped private
    "not-an-ip",
    "",
  ];
  for (const ip of bad) assert.equal(isPublicUnicastIp(ip), false, `must reject ${ip}`);
  assert.equal(isPublicUnicastIp("2606:4700:4700::1111"), true, "public v6 allowed");
  assert.equal(isPublicUnicastIp("::ffff:1.1.1.1"), true, "mapped public v4 allowed");
});

// 2026-09-02 adversarial audit (S1): the dotted-quad tail check was the only
// IPv4-embedding rule, so the same loopback written as `::ffff:7f00:1` (which
// is exactly what `new URL()` produces) passed as public.
test("isPublicUnicastIp unwraps every IPv4-embedding IPv6 form before judging", () => {
  const bad = [
    "::ffff:7f00:1", // mapped, hex
    "::FFFF:7F00:1", // mapped, upper-case
    "0:0:0:0:0:ffff:7f00:1", // mapped, no zero compression
    "0000:0000:0000:0000:0000:ffff:a9fe:a9fe", // mapped IMDS, fully expanded
    "::ffff:127.0.0.1", // mapped, dotted
    "::7f00:1", // IPv4-compatible (::/96)
    "::127.0.0.1", // IPv4-compatible, dotted
    "64:ff9b::7f00:1", // NAT64 well-known prefix
    "64:ff9b::a9fe:a9fe", // NAT64 → IMDS
    "64:ff9b::169.254.169.254", // NAT64, dotted
    "64:ff9b:1::7f00:1", // NAT64 local-use (64:ff9b:1::/48)
    "64:ff9b:1:abcd::c0a8:101", // NAT64 local-use → 192.168.1.1
    "2002:7f00:1::", // 6to4 → 127.0.0.1
    "2002:a9fe:a9fe::1", // 6to4 → 169.254.169.254
    "2002:0a00:0001::", // 6to4 → 10.0.0.1
    "fe80::1%eth0", // link-local with zone id
    "FE80::1", // link-local upper-case
    "FD00::1", // ULA upper-case
    "FF02::1", // multicast upper-case
    "0:0:0:0:0:0:0:1", // ::1 expanded
    "0:0:0:0:0:0:0:0", // :: expanded
  ];
  for (const ip of bad) assert.equal(isPublicUnicastIp(ip), false, `must reject ${ip}`);
  const good = [
    "::ffff:808:808", // mapped 8.8.8.8, hex
    "::ffff:8.8.8.8",
    "64:ff9b::808:808", // NAT64 → 8.8.8.8
    "2002:808:808::", // 6to4 → 8.8.8.8
    "2001:4860:4860::8888",
  ];
  for (const ip of good) assert.equal(isPublicUnicastIp(ip), true, `must allow ${ip}`);
});

test("resolveDeliveryTarget aborts when a hostname resolves to a private IP", async () => {
  const cases: Array<[string, string]> = [
    ["metadata.evil.test", "169.254.169.254"],
    ["rebind.evil.test", "10.0.0.5"],
    ["lo.evil.test", "127.0.0.1"],
    ["v6lo.evil.test", "::1"],
    ["cgnat.evil.test", "100.64.0.9"],
    ["mapped.evil.test", "::ffff:169.254.169.254"],
  ];
  for (const [host, ip] of cases) {
    const family = ip.includes(":") ? 6 : 4;
    const target = await resolveDeliveryTarget(host, async () => [{ address: ip, family }]);
    assert.equal(target, null, `${host} → ${ip} must be refused`);
  }
});

test("resolveDeliveryTarget aborts if ANY resolved address is private (mixed record)", async () => {
  const target = await resolveDeliveryTarget("mixed.evil.test", async () => [
    { address: "93.184.216.34", family: 4 }, // public
    { address: "169.254.169.254", family: 4 }, // poisoned second record
  ]);
  assert.equal(target, null, "a single private address in the set must abort delivery");
});

test("resolveDeliveryTarget pins a fully-public hostname to a concrete IP", async () => {
  const target = await resolveDeliveryTarget("good.partner.io", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  assert.deepEqual(target, { ip: "93.184.216.34", family: 4 });
});

test("resolveDeliveryTarget aborts on resolution failure or empty answer", async () => {
  assert.equal(
    await resolveDeliveryTarget("nx.evil.test", async () => {
      throw new Error("NXDOMAIN");
    }),
    null,
  );
  assert.equal(await resolveDeliveryTarget("empty.evil.test", async () => []), null);
});

// ---- events ----------------------------------------------------------------

test("event registry: known events pass, unknown are refused", () => {
  for (const e of WEBHOOK_EVENTS) assert.equal(isWebhookEvent(e), true);
  assert.equal(isWebhookEvent("score.changed"), false);
  assert.equal(isWebhookEvent(""), false);
});

// ---- signature -------------------------------------------------------------

test("secrets look like whsec_ and are unique", () => {
  const a = generateWebhookSecret();
  const b = generateWebhookSecret();
  assert.ok(a.startsWith("whsec_"));
  assert.ok(a.length > 20);
  assert.notEqual(a, b);
});

test("sign → verify round-trips", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ type: "outcome.recorded", data: { x: 1 } });
  const now = 1_770_000_000;
  const header = signWebhookPayload(secret, body, now);
  assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(verifyWebhookSignature(secret, body, header, now), true);
  assert.equal(verifyWebhookSignature(secret, body, header, now + 100), true, "within tolerance");
});

test("verification rejects tampering, wrong keys, and replays", () => {
  const secret = "whsec_test";
  const body = '{"a":1}';
  const now = 1_770_000_000;
  const header = signWebhookPayload(secret, body, now);

  assert.equal(verifyWebhookSignature(secret, '{"a":2}', header, now), false, "tampered body");
  assert.equal(verifyWebhookSignature("whsec_other", body, header, now), false, "wrong secret");
  assert.equal(
    verifyWebhookSignature(secret, body, header, now + 301),
    false,
    "stale beyond tolerance = replay",
  );
  assert.equal(verifyWebhookSignature(secret, body, "t=abc,v1=zz", now), false, "garbage header");
  assert.equal(verifyWebhookSignature(secret, body, "", now), false, "empty header");
  const flipped = header.slice(0, -1) + (header.endsWith("0") ? "1" : "0");
  assert.equal(verifyWebhookSignature(secret, body, flipped, now), false, "bit-flipped sig");
});

test("webhook signing secrets round-trip through at-rest sealing", () => {
  const previous = process.env.API_KEY_PEPPER;
  const previousKek = process.env.WEBHOOK_SECRET_KEK;
  const previousPrev = process.env.WEBHOOK_SECRET_KEK_PREVIOUS;
  process.env.API_KEY_PEPPER = "a".repeat(32);
  delete process.env.WEBHOOK_SECRET_KEK;
  delete process.env.WEBHOOK_SECRET_KEK_PREVIOUS;
  try {
    const plain = generateWebhookSecret();
    const sealed = sealWebhookSecret(plain);
    assert.notEqual(sealed, plain);
    assert.match(sealed, /^enc\.v1\./);
    assert.equal(openWebhookSecret(sealed).plain, plain);
    assert.equal(openWebhookSecret(sealed).reseal, null);
    const legacy = openWebhookSecret(plain);
    assert.equal(legacy.plain, plain, "legacy plaintext rows still open");
    assert.ok(legacy.reseal, "plaintext reseals onto the current KEK");
    assert.equal(openWebhookSecret(legacy.reseal!).plain, plain);
  } finally {
    if (previous === undefined) delete process.env.API_KEY_PEPPER;
    else process.env.API_KEY_PEPPER = previous;
    if (previousKek === undefined) delete process.env.WEBHOOK_SECRET_KEK;
    else process.env.WEBHOOK_SECRET_KEK = previousKek;
    if (previousPrev === undefined) delete process.env.WEBHOOK_SECRET_KEK_PREVIOUS;
    else process.env.WEBHOOK_SECRET_KEK_PREVIOUS = previousPrev;
  }
});

test("webhook secrets reopen with the previous KEK and reseal to the current one", () => {
  const saved = {
    kek: process.env.WEBHOOK_SECRET_KEK,
    prev: process.env.WEBHOOK_SECRET_KEK_PREVIOUS,
    pepper: process.env.API_KEY_PEPPER,
  };
  const oldKek = "old-webhook-kek-32-chars-minimum!";
  const newKek = "new-webhook-kek-32-chars-minimum!";
  try {
    process.env.WEBHOOK_SECRET_KEK = oldKek;
    delete process.env.WEBHOOK_SECRET_KEK_PREVIOUS;
    delete process.env.API_KEY_PEPPER;
    const plain = generateWebhookSecret();
    const sealedWithOld = sealWebhookSecret(plain);

    process.env.WEBHOOK_SECRET_KEK = newKek;
    process.env.WEBHOOK_SECRET_KEK_PREVIOUS = oldKek;
    const opened = openWebhookSecret(sealedWithOld);
    assert.equal(opened.plain, plain);
    assert.ok(opened.reseal);
    assert.notEqual(opened.reseal, sealedWithOld);

    delete process.env.WEBHOOK_SECRET_KEK_PREVIOUS;
    assert.equal(openWebhookSecret(opened.reseal!).plain, plain);
    assert.throws(() => openWebhookSecret(sealedWithOld));
  } finally {
    if (saved.kek === undefined) delete process.env.WEBHOOK_SECRET_KEK;
    else process.env.WEBHOOK_SECRET_KEK = saved.kek;
    if (saved.prev === undefined) delete process.env.WEBHOOK_SECRET_KEK_PREVIOUS;
    else process.env.WEBHOOK_SECRET_KEK_PREVIOUS = saved.prev;
    if (saved.pepper === undefined) delete process.env.API_KEY_PEPPER;
    else process.env.API_KEY_PEPPER = saved.pepper;
  }
});
