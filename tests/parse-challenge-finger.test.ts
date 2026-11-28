// Standalone test for challengeFinger fix (issue #101)
import { test } from "node:test";
import assert from "node:assert/strict";
import { challengeFinger, parseChallengeText, type ParsedChallenge } from "@/lib/diagnose/parse";

function assertFingerEqual(bodyText: string, headerText: string, message: string) {
  const body = parseChallengeText(bodyText);
  const header = parseChallengeText(headerText);
  assert.ok(body, "body parsed");
  assert.ok(header, "header parsed");
  const bodyFinger = challengeFinger(body);
  const headerFinger = challengeFinger(header);
  assert.strictEqual(bodyFinger, headerFinger, message);
}

test("challengeFinger: v2 header and v1 body with same terms produce same fingerprint", () => {
  // Issue #101: v2 header uses network="eip155:8453", amount="20000", resource at top level
  // v1 body uses network="base", maxAmountRequired="20000", resource in accepts[0].resource
  const headerV2 = JSON.stringify({
    x402Version: 2,
    resource: { url: "https://api.veritylayer.dev/verify/quick" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "20000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x89d38023167bdA453BeD9F6CbF22dDd1EC5f70a7",
      },
    ],
  });
  const bodyV1 = JSON.stringify({
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "20000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x89d38023167bdA453BeD9F6CbF22dDd1EC5f70a7",
        resource: "https://api.veritylayer.dev/verify/quick",
      },
    ],
  });
  assertFingerEqual(bodyV1, headerV2, "v1 body and v2 header with same terms should have same fingerprint");
});

test("challengeFinger: v2 header and v1 body with different amounts produce different fingerprints", () => {
  const headerV2 = JSON.stringify({
    x402Version: 2,
    resource: { url: "https://api.example/pay" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x89d38023167bdA453BeD9F6CbF22dDd1EC5f70a7",
      },
    ],
  });
  const bodyV1 = JSON.stringify({
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "2000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x89d38023167bdA453BeD9F6CbF22dDd1EC5f70a7",
        resource: "https://api.example/pay",
      },
    ],
  });
  const body = parseChallengeText(bodyV1);
  const header = parseChallengeText(headerV2);
  assert.ok(body);
  assert.ok(header);
  const bodyFinger = challengeFinger(body);
  const headerFinger = challengeFinger(header);
  assert.notStrictEqual(bodyFinger, headerFinger, "different amounts should produce different fingerprints");
});

test("challengeFinger: v2 header and v1 body with different networks produce different fingerprints", () => {
  const headerV2 = JSON.stringify({
    x402Version: 2,
    resource: { url: "https://api.example/pay" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x89d38023167bdA453BeD9F6CbF22dDd1EC5f70a7",
      },
    ],
  });
  const bodyV1 = JSON.stringify({
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "polygon", // different network
        maxAmountRequired: "1000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x89d38023167bdA453BeD9F6CbF22dDd1EC5f70a7",
        resource: "https://api.example/pay",
      },
    ],
  });
  const body = parseChallengeText(bodyV1);
  const header = parseChallengeText(headerV2);
  assert.ok(body);
  assert.ok(header);
  const bodyFinger = challengeFinger(body);
  const headerFinger = challengeFinger(header);
  assert.notStrictEqual(bodyFinger, headerFinger, "different networks should produce different fingerprints");
});

test("challengeFinger: deduplicates resources when topResource and accept.resource are the same", () => {
  // v2 style: resource at top level AND in accepts[0].resource
  const challenge = parseChallengeText(JSON.stringify({
    x402Version: 2,
    resource: { url: "https://api.example/pay" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x89d38023167bdA453BeD9F6CbF22dDd1EC5f70a7",
        resource: "https://api.example/pay", // duplicate
      },
    ],
  }));
  assert.ok(challenge);
  const finger = challengeFinger(challenge);
  // Should only have one resource in the fingerprint
  const parsed = JSON.parse(finger);
  assert.deepStrictEqual(parsed.resources, ["https://api.example/pay"], "resources should be deduplicated");
});

test("challengeFinger: normalizes asset address case", () => {
  const headerV2 = JSON.stringify({
    x402Version: 2,
    resource: { url: "https://api.example/pay" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000",
        asset: "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913", // uppercase
        payTo: "0x89d38023167bdA453BeD9F6CbF22dDd1EC5f70a7",
      },
    ],
  });
  const bodyV1 = JSON.stringify({
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "1000",
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // lowercase
        payTo: "0x89d38023167bdA453BeD9F6CbF22dDd1EC5f70a7",
        resource: "https://api.example/pay",
      },
    ],
  });
  assertFingerEqual(bodyV1, headerV2, "asset address case should be normalized");
});

test("challengeFinger: normalizes payTo address case", () => {
  const headerV2 = JSON.stringify({
    x402Version: 2,
    resource: { url: "https://api.example/pay" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x89D38023167BDA453BED9F6CBF22DDD1EC5F70A7", // uppercase
      },
    ],
  });
  const bodyV1 = JSON.stringify({
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "1000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x89d38023167bda453bed9f6cbf22ddd1ec5f70a7", // lowercase
        resource: "https://api.example/pay",
      },
    ],
  });
  assertFingerEqual(bodyV1, headerV2, "payTo address case should be normalized");
});