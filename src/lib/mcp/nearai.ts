import { getNearAiStore } from "@/lib/nearai/store";
import type { NearAiPublicSnapshot } from "@/lib/nearai/read-public";

export async function checkNearAiAttestation(): Promise<NearAiPublicSnapshot | "unavailable"> {
  try {
    const snapshot = await getNearAiStore().getLatestPublicSnapshot();
    if (!snapshot) return "unavailable";
    return snapshot;
  } catch {
    return "unavailable";
  }
}