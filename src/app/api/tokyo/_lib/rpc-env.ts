// Sepolia の RPC。env TOKYO_SEPOLIA_RPC_URL が無ければ公開の RPC（CLI の verify と同じ既定）。
// URL に API キーが入りうるので、この値は応答にもログにも出さない。
import { DEFAULT_RPC, SECONDARY_RPC } from "./constants";

export function readRpcUrl(): string {
  const v = process.env.TOKYO_SEPOLIA_RPC_URL?.trim();
  return v ? v : DEFAULT_RPC;
}

const hostOf = (u: string): string => {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
};

/** 検証は別々の提供者の RPC 2本で読む（SDK の pinBlock が両方の一致を見る）。 */
export function readVerifyRpcUrls(): { primary: string; secondary: string } {
  const primary = readRpcUrl();
  const secondary = hostOf(primary) === hostOf(SECONDARY_RPC) ? DEFAULT_RPC : SECONDARY_RPC;
  return { primary, secondary };
}
