import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { OpenApiRoot } from "./types";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml") as { load: (source: string) => unknown };

/** Canonical listings input: docs/openapi.yaml parsed to the same shape as /openapi.json. */
export function loadOpenApiFromRepo(root: string = process.cwd()): OpenApiRoot {
  const raw = readFileSync(join(root, "docs", "openapi.yaml"), "utf8");
  return load(raw) as OpenApiRoot;
}

export function listingsConfig(spec: OpenApiRoot) {
  const cfg = spec.info?.["x-vet402-listings"];
  if (!cfg || cfg.version !== 1) {
    throw new Error("openapi.info.x-vet402-listings version 1 is required");
  }
  return cfg;
}