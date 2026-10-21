// 2026-10-21: commit-day.sh put --source and --network after "--", where stellar-cli parses them as contract
// function arguments. Every hourly run failed with "could not read the chain" and 2026-10-20 was not committed.
// This runs writer_call against a fake stellar that fails the same way the real one does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = "contracts/stellar-roots/tools/commit-day.sh";

test("writer_call puts --source and --network before the contract arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "roots-"));
  const log = join(dir, "calls.log");
  writeFileSync(
    join(dir, "stellar"),
    `#!/bin/bash
after=0
for a in "$@"; do
  if [ "$a" = "--" ]; then after=1; continue; fi
  if [ $after = 1 ] && { [ "$a" = "--source" ] || [ "$a" = "--network" ]; }; then echo usage >&2; exit 2; fi
done
echo "$*" >> "${log}"
echo null
`,
  );
  chmodSync(join(dir, "stellar"), 0o755);
  const src = readFileSync(SCRIPT, "utf8");
  const fn = src.slice(src.indexOf("writer_call() {"), src.indexOf("\n}\n", src.indexOf("writer_call() {")) + 3);
  writeFileSync(join(dir, "wc.sh"), fn);
  execFileSync(
    "/bin/bash",
    [
      "-c",
      `source "${join(dir, "wc.sh")}"
writer_call contract invoke --id C1 --send=no -- get_root --day 20746
writer_call contract invoke --id C1 -- commit_root --day 1 --root ab --count 2
writer_call contract extend --id C1 --durability persistent --ledgers-to-extend 5`,
    ],
    { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
  );
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(calls.length, 3);
  assert.equal(calls[0], "contract invoke --id C1 --send=no --source vet402-roots-writer --network testnet -- get_root --day 20746");
  assert.equal(calls[1], "contract invoke --id C1 --source vet402-roots-writer --network testnet -- commit_root --day 1 --root ab --count 2");
  assert.equal(calls[2], "contract extend --id C1 --durability persistent --ledgers-to-extend 5 --source vet402-roots-writer --network testnet");
});
