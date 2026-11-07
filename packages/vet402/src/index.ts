// vet402: one package for both sides of an x402 payment.
//   import { check } from "vet402";          read what vet402 saw when it paid a URL
//   import { payOrRefuse } from "vet402/buyer";   everything in @vet402/sdk, plus check
//   import { createTrustGate } from "vet402/seller"; everything in @vet402/middleware
export {
  check,
  DEFAULT_API_URL,
  RECORD_URL_BASE,
  type CheckOptions,
  type CheckResult,
  type CheckFound,
  type CheckUnknown,
  type VerifiedTerms,
} from "./check.js";
