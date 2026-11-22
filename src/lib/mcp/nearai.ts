import { readNearAiObservatory, type NearAiObservatoryBody } from "@/lib/nearai/observatory-response";

export async function checkNearAiAttestation(): Promise<NearAiObservatoryBody | "unavailable"> {
  try {
    return await readNearAiObservatory();
  } catch {
    return "unavailable";
  }
}