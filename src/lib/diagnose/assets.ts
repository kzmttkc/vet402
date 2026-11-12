// 払える USDC の固定表。支払いモジュールは import しない（アドレスはここへ写す）。
import { isMainnet, isTestnet, toCaip2 } from "@/lib/observatory/chains";

export type PinnedAsset = { kind: "usdc"; decimals: number };

type Pin = { network: string; asset: string; decimals: number };

const PINS: readonly Pin[] = [
  { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  { network: "eip155:5042", asset: "0x3600000000000000000000000000000000000000", decimals: 6 },
  { network: "eip155:42220", asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6 },
  { network: "eip155:42161", asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
  { network: "eip155:43114", asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
  { network: "eip155:137", asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
  { network: "eip155:4217", asset: "0x20C000000000000000000000b9537d11c60E8b50", decimals: 6 },
  { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  { network: "stellar:pubnet", asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", decimals: 7 },
  { network: "stellar:pubnet", asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", decimals: 7 },
  { network: "xrpl:0", asset: "RLUSD", decimals: 6 },
  { network: "xrpl:0", asset: "524C555344000000000000000000000000000000", decimals: 6 },
];

/** 他網の USDC。その網では払わず、別の網に置かれていたら取り違えとする。 */
const FOREIGN: readonly { network: string; asset: string }[] = [
  { network: "eip155:1", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
];

export const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
export const RLUSD_HEX = "524C555344000000000000000000000000000000";
export const STELLAR_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const ATOMIC = /^[1-9][0-9]{0,77}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const XRPL_ADDR = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const STELLAR_ADDR = /^G[A-Z2-7]{55}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const SOL_SYSTEM = "11111111111111111111111111111111";
const SOL_INCINERATOR = "1nc1nerator11111111111111111111111111111111";
const XRPL_ZERO = "rrrrrrrrrrrrrrrrrrrrrhoLvTp";
const XRPL_ONE = "rrrrrrrrrrrrrrrrrrrrBZbvji";

export const READABLE_SCHEMES = new Set(["exact", "upto", "batch-settlement", "auth-capture"]);

export function canonicalNetwork(network: string): string {
  return toCaip2(network) ?? network;
}

export function isKnownMainnet(network: string): boolean {
  const caip = canonicalNetwork(network);
  if (caip === "stellar:pubnet") return true;
  return isMainnet(caip);
}

export function isKnownTestnet(network: string): boolean {
  const caip = canonicalNetwork(network);
  if (caip === "stellar:testnet" || caip === "stellar:futurenet") return true;
  return isTestnet(caip);
}

function assetKey(asset: string): string {
  if (asset.startsWith("0x") || asset.startsWith("0X")) return asset.toLowerCase();
  if (asset.toUpperCase() === "RLUSD") return "RLUSD";
  if (asset.toUpperCase() === RLUSD_HEX) return RLUSD_HEX;
  return asset;
}

export function pinnedAssetFor(network: string, asset: string): PinnedAsset | null {
  const net = canonicalNetwork(network);
  const key = assetKey(asset);
  const hit = PINS.find((pin) => pin.network === net && assetKey(pin.asset) === key);
  return hit ? { kind: "usdc", decimals: hit.decimals } : null;
}

export function assetRelation(network: string, asset: string): "pinned" | "mixup" | "unknown" {
  if (pinnedAssetFor(network, asset)) return "pinned";
  const net = canonicalNetwork(network);
  const key = assetKey(asset);
  const elsewhere = [...PINS, ...FOREIGN].some((pin) => pin.network !== net && assetKey(pin.asset) === key);
  return elsewhere ? "mixup" : "unknown";
}

export function atomicAmountOk(amount: string): boolean {
  return ATOMIC.test(amount);
}

export function usdAtomic(amount: string, decimals: number): string | null {
  if (!atomicAmountOk(amount)) return null;
  const value = BigInt(amount);
  if (decimals === 6) return value.toString();
  if (decimals > 6) return (value / 10n ** BigInt(decimals - 6)).toString();
  return (value * 10n ** BigInt(6 - decimals)).toString();
}

type Family = "evm" | "solana" | "xrpl" | "stellar" | "other";

export function networkFamily(network: string): Family {
  const caip = canonicalNetwork(network).toLowerCase();
  if (caip.startsWith("eip155:")) return "evm";
  if (caip.startsWith("solana:")) return "solana";
  if (caip.startsWith("xrpl")) return "xrpl";
  if (caip.startsWith("stellar")) return "stellar";
  return "other";
}

export function isSolanaNetwork(network: string): boolean {
  return networkFamily(network) === "solana";
}

export function needsAccountReadiness(network: string): boolean {
  const caip = canonicalNetwork(network);
  return caip === "xrpl:0" || caip === "stellar:pubnet";
}

function evmBurn(payTo: string): boolean {
  const low = payTo.toLowerCase();
  return low === ZERO || low === DEAD;
}

export function payToOk(network: string, payTo: string): boolean {
  const family = networkFamily(network);
  if (family === "evm") return EVM.test(payTo) && !evmBurn(payTo);
  if (family === "solana") return BASE58.test(payTo) && payTo !== SOL_SYSTEM && payTo !== SOL_INCINERATOR;
  if (family === "xrpl") return XRPL_ADDR.test(payTo) && payTo !== XRPL_ZERO && payTo !== XRPL_ONE;
  if (family === "stellar") return STELLAR_ADDR.test(payTo);
  return false;
}

export function solanaFeePayerOk(payTo: string, feePayer: string | null): boolean {
  if (!feePayer || !BASE58.test(feePayer)) return false;
  if (feePayer === payTo) return false;
  if (feePayer === SOL_SYSTEM || feePayer === SOL_INCINERATOR) return false;
  return true;
}

export function isRlusdCurrency(currency: string): boolean {
  const upper = currency.toUpperCase();
  return upper === "RLUSD" || upper === RLUSD_HEX;
}
