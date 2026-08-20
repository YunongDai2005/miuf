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
  discoverySeedUrls?: string[];
  venueIds: string[];
  confidence: number;
  resolutionSource: OperatorResolutionSource;
  evidenceUrls: string[];
  auditedAt?: string;
}

export interface OperatorOverride {
  name: string;
  website: string;
  discoverySeedUrls?: string[];
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
  /** SHA-256 of the exact attraction snapshot used to build this inventory. */
  sourceHash?: string;
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
  /** Google Place IDs may be retained, but the remaining Places payload is runtime-only. */
  sourcePlaceIds?: string[];
  /** Pending candidates cannot be published until they map to the open venue index. */
  canonicalizationStatus?: "mapped" | "pending";
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
    sourcePlaceIds?: string[];
    error: string;
  }>;
  /** Completed crawl scopes make interrupted discovery resumable. */
  completedScopes?: DiscoveryCheckpoint[];
}

export type VenueEndpointScanStatus =
  | "reviewed_endpoint"
  | "lost_found_candidate"
  | "official_contact_candidate"
  | "scanned_no_endpoint"
  | "pending_scan"
  | "parent_venue_candidate"
  | "no_official_source";

export interface VenueEndpointSummary {
  source: "reviewed" | "candidate";
  id: string;
  kind: ChannelKind | "manual_review";
  pageUrl: string;
  formAction?: string;
  formMethod?: "GET" | "POST";
  contactValue?: string;
  hasForm: boolean;
  fieldCount: number;
  captcha: boolean;
  loginRequired: boolean;
  lostPropertyEvidence: boolean;
  confidence?: number;
  verifiedAt?: string;
}

export interface VenueEndpointScanRecord {
  venueId: string;
  venueName: string;
  category: string;
  status: VenueEndpointScanStatus;
  officialWebsite?: string;
  operatorId?: string;
  operatorName?: string;
  operatorWebsite?: string;
  parentVenueCandidateId?: string;
  scanned: boolean;
  bestEndpoint?: VenueEndpointSummary;
  endpoints: VenueEndpointSummary[];
}

export interface VenueEndpointScanFile {
  version: 1;
  generatedAt: string;
  inventoryGeneratedAt: string;
  candidateGeneratedAt: string[];
  registryGeneratedAt: string;
  records: VenueEndpointScanRecord[];
  summary: {
    totalVenues: number;
    scannableVenues: number;
    scannedVenues: number;
    endpointVenues: number;
    rejectedCandidates: number;
    statusCounts: Record<VenueEndpointScanStatus, number>;
  };
}

export interface DiscoveryCheckpoint {
  scopeId: string;
  origin: string;
  venueIds: string[];
  completedAt: string;
}

export type ResponsibilityKind = "operator" | "venue" | "guidance";

export type VenueResponsibilityResolution =
  | "reviewed_channel"
  | "audited_operator"
  | "official_venue"
  | "parent_candidate"
  | "manual_guidance";

export type ResponsibilityTrust =
  | "reviewed"
  | "official"
  | "candidate"
  | "fallback";

export interface ResponsibilityRecord {
  id: string;
  kind: ResponsibilityKind;
  name: string;
  operatorId?: string;
  website?: string;
  venueIds: string[];
  channelIds: string[];
  confidence: number;
  audited: boolean;
  auditedAt?: string;
  evidenceUrls: string[];
}

export interface VenueResponsibilityAssignment {
  venueId: string;
  responsibilityId: string;
  resolution: VenueResponsibilityResolution;
  trust: ResponsibilityTrust;
  channelIds: string[];
  parentVenueId?: string;
  confidence: number;
  evidenceUrls: string[];
}

export interface ResponsibilityGraph {
  version: 1;
  generatedAt: string;
  inventoryGeneratedAt: string;
  channelRegistryGeneratedAt: string;
  responsibilities: ResponsibilityRecord[];
  assignments: VenueResponsibilityAssignment[];
  summary: {
    totalVenues: number;
    resolvedVenues: number;
    reviewedChannel: number;
    officialContact: number;
    parentCandidate: number;
    manualGuidance: number;
    actionableCoverageRate: number;
    functionalCoverageRate: number;
    /**
     * The place index doubles as the vocabulary for naming where a photograph
     * was taken, so it contains many outdoor objects — sculptures, memorial
     * plaques, viewpoints — that have no staff and therefore cannot have a
     * lost-property channel of their own. Measuring channel coverage against
     * all of them understates the result and misdescribes the problem, so the
     * population is reported separately.
     */
    addressableVenues: number;
    /** A reviewed lost-property route, or an audited operator that owns one. */
    addressableWithRoute: number;
    /** Only the venue's own website is known; the traveller still has to search it. */
    addressableWithSourceOnly: number;
    addressableRouteRate: number;
    inheritsFromParent: number;
    noVenueOfficePossible: number;
  };
}

export interface ReviewDecision {
  candidateId: string;
  decision: "accept" | "reject";
  reviewedAt: string;
  reviewedBy: string;
  /**
   * Who is answerable for this decision. Human acceptance is publishable;
   * automated acceptance additionally requires the current source-grounded
   * attestation below. Left unset on legacy decisions, which publication treats
   * as not yet confirmed.
   */
  reviewerKind?: "human" | "automated";
  /**
   * Required proof for an automated acceptance. It is emitted only after the
   * current page, the model quote and the deterministic destination checks all
   * pass. Publication refuses an automated accept without this record.
   */
  automatedAudit?: {
    method: "source_grounded_model";
    policyVersion: string;
    model: string;
    sourceHash: string;
    evidenceQuoteHash: string;
    finalUrl: string;
  };
  /** Exact destination, scope and evidence snapshot that was reviewed. */
  reviewedCandidateVersion: string;
  notes?: string;
  kindOverride?: ChannelKind;
  /** Explicitly distinguishes a lost-property route from a general contact fallback. */
  purposeOverride?: import("../../lib/lost-found-channel-schema").ChannelPurpose;
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
  adapters: import("../../lib/lost-found-channel-schema").FormAdapter[];
}
