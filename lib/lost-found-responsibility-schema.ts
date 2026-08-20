export const LOST_FOUND_RESPONSIBILITY_INDEX_VERSION = 1 as const;

export type LostFoundResponsibilityKind = "operator" | "venue" | "guidance";

export type LostFoundResponsibilityResolution =
  | "reviewed_channel"
  | "audited_operator"
  | "official_venue"
  | "parent_candidate"
  | "manual_guidance";

export type LostFoundResponsibilityTrust =
  | "reviewed"
  | "official"
  | "candidate"
  | "fallback";

export interface PublicLostFoundResponsibility {
  id: string;
  kind: LostFoundResponsibilityKind;
  name: string;
  website?: string;
  audited: boolean;
  auditedAt?: string;
  evidenceUrls: string[];
}

export interface PublicVenueResponsibilityAssignment {
  venueId: string;
  responsibilityId: string;
  resolution: LostFoundResponsibilityResolution;
  trust: LostFoundResponsibilityTrust;
  channelIds: string[];
  parentVenueId?: string;
  confidence: number;
}

/** Compact, privacy-neutral responsibility data shipped with the offline app. */
export interface PublicLostFoundResponsibilityIndex {
  version: typeof LOST_FOUND_RESPONSIBILITY_INDEX_VERSION;
  generatedAt: string;
  responsibilities: PublicLostFoundResponsibility[];
  assignments: PublicVenueResponsibilityAssignment[];
}

export interface ResolvedLostFoundResponsibility {
  responsibility: PublicLostFoundResponsibility;
  assignment: PublicVenueResponsibilityAssignment;
}

const RESPONSIBILITY_KINDS = new Set<LostFoundResponsibilityKind>([
  "operator",
  "venue",
  "guidance",
]);
const RESOLUTIONS = new Set<LostFoundResponsibilityResolution>([
  "reviewed_channel",
  "audited_operator",
  "official_venue",
  "parent_candidate",
  "manual_guidance",
]);
const TRUST_LEVELS = new Set<LostFoundResponsibilityTrust>([
  "reviewed",
  "official",
  "candidate",
  "fallback",
]);

function validUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export function isPublicLostFoundResponsibilityIndex(
  value: unknown
): value is PublicLostFoundResponsibilityIndex {
  if (!value || typeof value !== "object") return false;
  const index = value as Partial<PublicLostFoundResponsibilityIndex>;
  if (
    index.version !== LOST_FOUND_RESPONSIBILITY_INDEX_VERSION ||
    typeof index.generatedAt !== "string" ||
    !Array.isArray(index.responsibilities) ||
    !Array.isArray(index.assignments)
  ) {
    return false;
  }
  const responsibilityIds = new Set<string>();
  for (const responsibility of index.responsibilities) {
    if (
      !responsibility ||
      typeof responsibility.id !== "string" ||
      !responsibility.id ||
      responsibilityIds.has(responsibility.id) ||
      !RESPONSIBILITY_KINDS.has(responsibility.kind) ||
      typeof responsibility.name !== "string" ||
      !responsibility.name.trim() ||
      typeof responsibility.audited !== "boolean" ||
      (responsibility.auditedAt !== undefined &&
        (typeof responsibility.auditedAt !== "string" ||
          !Number.isFinite(Date.parse(responsibility.auditedAt)))) ||
      (responsibility.website !== undefined &&
        !validUrl(responsibility.website)) ||
      !Array.isArray(responsibility.evidenceUrls) ||
      responsibility.evidenceUrls.some((url) => !validUrl(url))
    ) {
      return false;
    }
    responsibilityIds.add(responsibility.id);
  }
  const venueIds = new Set<string>();
  for (const assignment of index.assignments) {
    if (
      !assignment ||
      typeof assignment.venueId !== "string" ||
      !assignment.venueId ||
      venueIds.has(assignment.venueId) ||
      !responsibilityIds.has(assignment.responsibilityId) ||
      !RESOLUTIONS.has(assignment.resolution) ||
      !TRUST_LEVELS.has(assignment.trust) ||
      !Array.isArray(assignment.channelIds) ||
      assignment.channelIds.some(
        (channelId) => typeof channelId !== "string" || !channelId
      ) ||
      (assignment.parentVenueId !== undefined &&
        (typeof assignment.parentVenueId !== "string" ||
          !assignment.parentVenueId)) ||
      !Number.isFinite(assignment.confidence) ||
      assignment.confidence < 0 ||
      assignment.confidence > 1
    ) {
      return false;
    }
    venueIds.add(assignment.venueId);
  }
  return true;
}

export function resolveVenueResponsibility(
  index: PublicLostFoundResponsibilityIndex | undefined,
  venueId: string
): ResolvedLostFoundResponsibility | undefined {
  if (!index) return undefined;
  const assignment = index.assignments.find((entry) => entry.venueId === venueId);
  if (!assignment) return undefined;
  const responsibility = index.responsibilities.find(
    (entry) => entry.id === assignment.responsibilityId
  );
  return responsibility ? { responsibility, assignment } : undefined;
}
