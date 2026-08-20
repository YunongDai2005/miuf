import type { LiveJourneyCandidate } from "../berlin-transit/vbb";
import type { OfflineRoutePlan } from "./offlineRoute";
import type { PhotoAnchor } from "./photos";

/**
 * Transient, on-device geometry used by the review map. It deliberately stays
 * outside LostCase/localStorage because photo coordinates are only needed while
 * the current app session is open.
 */
export interface RoutePreview {
  anchors: PhotoAnchor[];
  journey: LiveJourneyCandidate | null;
  offlinePlan: OfflineRoutePlan | null;
  dayKey: string | null;
}
