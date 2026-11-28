#!/usr/bin/env node
// Generate listing drafts from docs/openapi.yaml (JSON twin is the canonical input snapshot).
//
//   npx tsx scripts/listings/generate.ts              # write data/listings/*
//   npx tsx scripts/listings/generate.ts --check      # drift line counts; exit 1 when any > 0
//   npx tsx scripts/listings/generate.ts --check --observe   # print drift, always exit 0
//   --root <dir>   read docs/openapi.yaml and write data/listings under <dir> (tests)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { countLineDrift } from "@/lib/listings/stable-json";
import {
  LISTING_DESTINATION_LABELS,
  LISTING_OUTPUT_PATHS,
  generateListingFiles,
} from "@/lib/listings/generate-from-openapi";
import { loadOpenApiFromRepo } from "@/lib/listings/load-openapi";
import type { ListingDestination } from "@/lib/listings/types";

const rootFlag = process.argv.indexOf("--root");
const root = rootFlag !== -1 && process.argv[rootFlag + 1] ? process.argv[rootFlag + 1]! : process.cwd();
const check = process.argv.includes("--check");
const observe = process.argv.includes("--observe");

const spec = loadOpenApiFromRepo(root);
const generated = generateListingFiles(spec, root);

function writeAll() {
  for (const dest of Object.keys(LISTING_OUTPUT_PATHS) as ListingDestination[]) {
    const rel = LISTING_OUTPUT_PATHS[dest];
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, generated[dest], "utf8");
  }
  console.log("listings: wrote", Object.keys(LISTING_OUTPUT_PATHS).length, "destinations under data/listings/");
}

function checkAll() {
  let totalDrift = 0;
  const rows: Array<{ dest: ListingDestination; drift: number; path: string }> = [];
  for (const dest of Object.keys(LISTING_OUTPUT_PATHS) as ListingDestination[]) {
    const rel = LISTING_OUTPUT_PATHS[dest];
    const abs = join(root, rel);
    let onDisk = "";
    try {
      onDisk = readFileSync(abs, "utf8");
    } catch {
      rows.push({ dest, drift: generated[dest].split("\n").length, path: rel });
      totalDrift += generated[dest].split("\n").length;
      continue;
    }
    const drift = countLineDrift(generated[dest], onDisk);
    rows.push({ dest, drift, path: rel });
    totalDrift += drift;
  }
  for (const row of rows) {
    const label = LISTING_DESTINATION_LABELS[row.dest];
    console.log(`${label}: drift_lines=${row.drift} path=${row.path}`);
  }
  console.log(`listings: total_drift_lines=${totalDrift}`);
  if (totalDrift > 0 && !observe) process.exit(1);
}

if (check) checkAll();
else writeAll();
