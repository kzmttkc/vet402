// 読み取り専用: 我々を validator に指名した ERC-8004 validation request を数える。
// Usage: npx tsx scripts/registry-inbox.ts [--blocks 200000] [--validator 0x…]
import { scanRegistryInbox } from "../src/lib/chain/registry-inbox";

const argBlocks = process.argv.indexOf("--blocks");
const argValidator = process.argv.indexOf("--validator");
const blocks = argBlocks >= 0 ? BigInt(process.argv[argBlocks + 1]) : 200_000n;
const validator = (argValidator >= 0 ? process.argv[argValidator + 1] : process.env.REGISTRY_OPERATOR_ADDRESS) as `0x${string}` | undefined;
if (!validator) {
  console.error("validator address required: --validator 0x… (or REGISTRY_OPERATOR_ADDRESS)");
  process.exit(2);
}
async function main() {
  const scan = await scanRegistryInbox({ validator: validator as `0x${string}`, blocks });
  console.log(JSON.stringify(scan, null, 2));
  console.log(
    `[registry:inbox] 我々宛 ${scan.addressedToUs.length} 件 / レジストリ全体 ${scan.totalLogs} 件 ` +
      `(${scan.blocksScanned} ブロック走査・署名確認 ${scan.eventSignatureConfirmed ? "済" : "未"})`,
  );
}

void main();
