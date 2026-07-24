import type {
  ChannelField,
  ChannelKind,
  ClaimEvidence,
} from "../../lib/lost-found-channel-schema";

export type VenueResolutionStatus =
  | "independent_candidate"
  | "parent_venue_required"
  | "insufficient_source";

export type OperatorResolutionSource =
  | "metadata_candidate"
  | "official_source_audit";

export interface VenueOwnerResolution {
  venueId: string;
  venueName: string;
  category: string;
  point: [number, number];
  entityGroupId: string;
  canonicalVenueId: string;
  parentVenueCandidateId?: string;
  parentCandidateDistanceMeters?: number;
  officialWebsite?: string;
  operatorId?: string;
  operatorName?: string;
  operatorWebsite?: string;
  operatorResolutionSource?: OperatorResolutionSource;
  resolutionStatus: VenueResolutionStatus;
  confidence: number;
  evidenceUrls: string[];
}

export interface OperatorRecord {
  id: string;
  name: string;
  website?: string;
  venueIds: string[];
  confidence: number;
  resolutionSource: OperatorResolutionSource;
  evidenceUrls: string[];
}

export interface OperatorOverride {
  name: string;
  website: string;
  matchWebsiteHosts?: string[];
  venueIds?: string[];
  evidenceUrls: string[];
  auditedAt: string;
}

export interface OperatorOverrideFile {
  version: 1;
  operators: OperatorOverride[];
}

export interface InventoryFile {
  version: 1;
  generatedAt: string;
  sourceFile: string;
  operators: OperatorRecord[];
  entityGroups: Array<{
    id: string;
    canonicalVenueId: string;
    venueIds: string[];
    reason: "wikidata" | "near_duplicate" | "single";
  }>;
  venues: VenueOwnerResolution[];
  summary: {
    totalVenues: number;
    independentCandidates: number;
    parentVenueRequired: number;
    insufficientSource: number;
    explicitOperators: number;
    officialWebsites: number;
    duplicateGroups: number;
    parentCandidates: number;
  };
}

export interface DiscoveryPathStep {
  url: string;
  label: string;
}

export interface FormSnapshot {
  pageUrl: string;
  formAction?: string;
  formMethod: "GET" | "POST";
  title: string;
  contextText: string;
  language: string[];
  fields: ChannelField[];
  captcha: boolean;
  loginRequired: boolean;
  contentHash: string;
}

export interface ChannelCandidate {
  id: string;
  operatorId?: string;
  venueIds: string[];
  kind: ChannelKind | "manual_review";
  pageUrl: string;
  contactValue?: string;
  form?: FormSnapshot;
  confidence: number;
  reasons: string[];
  discoveryPath: DiscoveryPathStep[];
  evidence: ClaimEvidence[];
  fetchStatus: "ok" | "blocked" | "failed";
  reviewStatus: "candidate" | "needs_review" | "rejected";
  discoveredAt: string;
}

export interface CandidateFile {
  version: 1;
  generatedAt: string;
  candidates: ChannelCandidate[];
  failures: Array<{
    seedUrl: string;
    venueIds: string[];
    error: string;
  }>;
}

export interface ReviewDecision {
  candidateId: string;
  decision: "accept" | "reject";
  reviewedAt: string;
  reviewedBy: string;
  /** Exact destination, scope and evidence snapshot that was reviewed. */
  reviewedCandidateVersion: string;
  notes?: string;
  kindOverride?: ChannelKind;
  venueIdsOverride?: string[];
  submissionMode?: "open_only" | "assisted_fill" | "adapter";
  adapterId?: string;
  /** Exact form version whose field meanings the reviewer checked. */
  reviewedContentHash?: string;
}

export interface ReviewFile {
  version: 1;
  decisions: ReviewDecision[];
}

export interface AdapterFile {
  version: 1;
  adapters: import("../../lib/lost-found-channel-schema").SubmissionAdapter[];
}
