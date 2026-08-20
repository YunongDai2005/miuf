import {
  CHANNEL_REGISTRY_VERSION,
  isPublishedChannelRegistry,
  isPublishedLostFoundChannel,
  publishedChannelPurpose,
  type PublishedChannelRegistry,
  type PublishedLostFoundChannel,
} from "./lost-found-channel-schema";
import type {
  AdapterFile,
  CandidateFile,
  ResponsibilityGraph,
  ReviewFile,
} from "../scripts/lost-found-crawler/schemas";
import {
  automatedReviewAttestationIsCurrent,
  candidateReviewVersion,
} from "./channel-review";

const FORM_KINDS = new Set([
  "dedicated_lost_found_form",
  "operator_lost_found_form",
  "general_contact_form",
]);

function canonicalPublicUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().toLowerCase();
  }
}

function publishedChannelIdentity(channel: PublishedLostFoundChannel): string {
  const contact = channel.contactValue
    ? channel.kind === "phone"
      ? channel.contactValue.replace(/\D/g, "")
      : channel.contactValue.trim().toLowerCase()
    : channel.formAction
      ? canonicalPublicUrl(channel.formAction)
      : canonicalPublicUrl(channel.pageUrl);
  return [
    channel.kind,
    canonicalPublicUrl(channel.pageUrl),
    contact,
  ].join("\0");
}

/**
 * Add newly reviewed channels to the last published registry without making an
 * unrelated candidate refresh delete the audited baseline. Explicit removals
 * still use the publisher's coverage-regression override.
 */
export function mergePublishedChannelRegistries(
  baseline: PublishedChannelRegistry,
  incoming: PublishedChannelRegistry
): PublishedChannelRegistry {
  const merged = new Map<string, PublishedLostFoundChannel>();
  const identityById = new Map<string, string>();
  const add = (channel: PublishedLostFoundChannel) => {
    const identity = publishedChannelIdentity(channel);
    const previousIdentity = identityById.get(channel.id);
    if (previousIdentity && previousIdentity !== identity) {
      merged.delete(previousIdentity);
    }
    const existing = merged.get(identity);
    if (!existing) {
      merged.set(identity, {
        ...channel,
        venueIds: [...new Set(channel.venueIds)].sort(),
        fields: [...channel.fields],
        evidence: [...channel.evidence],
      });
      identityById.set(channel.id, identity);
      return;
    }
    const existingPurpose = publishedChannelPurpose(existing);
    const incomingPurpose = publishedChannelPurpose(channel);
    const preferred =
      existingPurpose !== incomingPurpose
        ? incomingPurpose === "lost_property"
          ? channel
          : existing
        : channel.verifiedAt >= existing.verifiedAt
          ? channel
          : existing;
    const combined = {
      ...preferred,
      venueIds: [...new Set([...existing.venueIds, ...channel.venueIds])].sort(),
      fields: [...preferred.fields],
      evidence: [...preferred.evidence],
    };
    merged.set(identity, combined);
    identityById.set(existing.id, identity);
    identityById.set(channel.id, identity);
  };
  baseline.channels.forEach(add);
  incoming.channels.forEach(add);
  const registry: PublishedChannelRegistry = {
    version: CHANNEL_REGISTRY_VERSION,
    generatedAt:
      incoming.channels.length > 0 &&
      incoming.generatedAt > baseline.generatedAt
        ? incoming.generatedAt
        : baseline.generatedAt,
    channels: [...merged.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
  };
  if (!isPublishedChannelRegistry(registry)) {
    throw new Error("Merged channel registry is invalid");
  }
  return registry;
}

export function buildPublishedChannelRegistry(input: {
  candidates: CandidateFile;
  reviews: ReviewFile;
  adapters: AdapterFile;
  responsibilities?: ResponsibilityGraph;
  generatedAt?: string;
}): PublishedChannelRegistry {
  const { candidates, reviews, adapters, responsibilities } = input;
  if (
    candidates.version !== 1 ||
    reviews.version !== 1 ||
    adapters.version !== 1
  ) {
    throw new Error("Unsupported candidate, review or adapter file version");
  }

  const candidatesById = new Map(
    candidates.candidates.map((candidate) => [candidate.id, candidate])
  );
  const channels: PublishedLostFoundChannel[] = [];
  const acceptedIds = new Set<string>();

  for (const decision of reviews.decisions) {
    if (decision.decision !== "accept") continue;
    if (acceptedIds.has(decision.candidateId)) {
      throw new Error(`Duplicate accepted review for ${decision.candidateId}`);
    }
    const candidate = candidatesById.get(decision.candidateId);
    if (!candidate) {
      throw new Error(
        `Accepted review references missing candidate ${decision.candidateId}`
      );
    }
    if (
      decision.reviewedCandidateVersion !== candidateReviewVersion(candidate)
    ) {
      throw new Error(
        `Candidate ${candidate.id} changed after its destination review`
      );
    }
    const kind = decision.kindOverride ?? candidate.kind;
    if (kind === "manual_review") {
      throw new Error(
        `Accepted candidate ${candidate.id} needs an explicit kindOverride`
      );
    }
    const reviewedTimestamp = Date.parse(decision.reviewedAt);
    if (
      !decision.reviewedBy.trim() ||
      !decision.reviewedAt.match(/^20\d{2}-\d{2}-\d{2}/) ||
      !Number.isFinite(reviewedTimestamp)
    ) {
      throw new Error(
        `Accepted candidate ${candidate.id} has incomplete reviewer metadata`
      );
    }
    if (decision.reviewerKind === "automated") {
      if (!automatedReviewAttestationIsCurrent(decision)) {
        throw new Error(
          `Automated acceptance ${candidate.id} has no current source-grounded audit attestation`
        );
      }
    } else if (decision.reviewerKind !== "human") {
      throw new Error(
        `Accepted candidate ${candidate.id} requires a human review or a source-grounded automated audit`
      );
    }
    const venueIds = (() => {
      if (decision.venueIdsOverride) return decision.venueIdsOverride;
      const directVenueIds = new Set(candidate.venueIds);
      if (!candidate.operatorId || responsibilities?.version !== 1) {
        return [...directVenueIds];
      }
      const responsibility = responsibilities.responsibilities.find(
        (entry) =>
          entry.kind === "operator" &&
          entry.operatorId === candidate.operatorId &&
          entry.audited
      );
      if (!responsibility) return [...directVenueIds];
      for (const assignment of responsibilities.assignments) {
        if (
          assignment.responsibilityId === responsibility.id &&
          (assignment.resolution === "reviewed_channel" ||
            assignment.resolution === "audited_operator")
        ) {
          directVenueIds.add(assignment.venueId);
        }
      }
      return [...directVenueIds];
    })();
    if (
      candidate.canonicalizationStatus === "pending" &&
      !decision.venueIdsOverride?.length
    ) {
      throw new Error(
        `Accepted Google candidate ${candidate.id} still needs an open venue assignment`
      );
    }
    if (
      venueIds.length === 0 ||
      venueIds.some((venueId) => !venueId.trim())
    ) {
      throw new Error(
        `Accepted candidate ${candidate.id} has no valid venue assignment`
      );
    }
    const form = candidate.form;
    if (FORM_KINDS.has(kind) && (!form || form.fields.length === 0)) {
      throw new Error(
        `Candidate ${candidate.id} cannot publish a form kind without an extracted form`
      );
    }
    if (
      kind === "email" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate.contactValue ?? "")
    ) {
      throw new Error(
        `Candidate ${candidate.id} has no valid reviewed email value`
      );
    }
    if (
      kind === "phone" &&
      (candidate.contactValue ?? "").replace(/\D/g, "").length < 6
    ) {
      throw new Error(
        `Candidate ${candidate.id} has no valid reviewed phone value`
      );
    }

    const defaultSubmissionMode = "open_only";
    if (
      (decision.submissionMode === "assisted_fill" ||
        decision.submissionMode === "adapter") &&
      (!form || form.fields.length === 0)
    ) {
      throw new Error(
        `Candidate ${candidate.id} cannot enable assisted filling without extracted form fields`
      );
    }
    if (
      (decision.submissionMode === "assisted_fill" ||
        decision.submissionMode === "adapter") &&
      decision.reviewedContentHash !== form?.contentHash
    ) {
      throw new Error(
        `Candidate ${candidate.id} form changed after its field review`
      );
    }
    const adapter = decision.adapterId
      ? adapters.adapters.find((entry) => entry.id === decision.adapterId)
      : undefined;
    if (decision.adapterId) {
      if (
        !adapter ||
        adapter.channelId !== candidate.id ||
        adapter.testedContentHash !== candidate.form?.contentHash ||
        new URL(candidate.pageUrl).origin !== adapter.origin
      ) {
        throw new Error(
          `Candidate ${candidate.id} cannot publish a form adapter without an exact channel, origin and content-hash match`
        );
      }
      try {
        new RegExp(adapter.pathPattern);
      } catch {
        throw new Error(
          `Candidate ${candidate.id} adapter has an invalid path pattern`
        );
      }
    }
    if (decision.submissionMode === "adapter") {
      if (
        !adapter ||
        adapter.capability !== "reviewed_submit"
      ) {
        throw new Error(
          `Candidate ${candidate.id} cannot publish adapter mode without a matching tested submission adapter`
        );
      }
      if (
        !adapter.submitSelector?.trim() ||
        (!adapter.successSelector?.trim() && !adapter.successText?.trim())
      ) {
        throw new Error(
          `Candidate ${candidate.id} adapter needs a submit selector and a reviewed success state`
        );
      }
    } else if (
      decision.submissionMode === "assisted_fill" &&
      adapter &&
      adapter.capability !== "fill_only" &&
      adapter.capability !== "reviewed_submit"
    ) {
      throw new Error(
        `Candidate ${candidate.id} has an unsupported filling adapter capability`
      );
    }

    const publishedChannel: PublishedLostFoundChannel = {
      id: candidate.id,
      operatorId: candidate.operatorId,
      venueIds: [...new Set(venueIds)].sort(),
      kind,
      purpose:
        decision.purposeOverride ??
        (kind === "general_contact_form" || kind === "central_office_fallback"
          ? "general_contact_fallback"
          : "lost_property"),
      scope: candidate.operatorId ? "operator" : "venue",
      pageUrl: candidate.pageUrl,
      contactValue: candidate.contactValue,
      formAction: form?.formAction,
      formMethod: form?.formMethod,
      language: form?.language ?? ["und"],
      fields: form?.fields.filter((field) => field.control !== "hidden") ?? [],
      captcha: form?.captcha ?? false,
      loginRequired: form?.loginRequired ?? false,
      submissionMode: decision.submissionMode ?? defaultSubmissionMode,
      adapterId:
        decision.submissionMode === "assisted_fill" ||
        decision.submissionMode === "adapter"
          ? decision.adapterId
          : undefined,
      verifiedAt: decision.reviewedAt,
      reviewDueAt: new Date(
        reviewedTimestamp + 90 * 24 * 60 * 60 * 1000
      ).toISOString(),
      // Section 4.5: a reviewer's identity stays in the private review file, so
      // the registry records how the decision was reached rather than by whom.
      // An automated acceptance says so, and the client can label it.
      verifiedBy:
        decision.reviewerKind === "automated"
          ? "automated source audit"
          : "authenticated reviewer",
      evidence: candidate.evidence,
      contentHash:
        form?.contentHash ?? candidate.evidence[0]?.contentHash ?? "",
    };
    if (!isPublishedLostFoundChannel(publishedChannel)) {
      throw new Error(
        `Candidate ${candidate.id} produced an invalid public channel`
      );
    }
    channels.push(publishedChannel);
    acceptedIds.add(decision.candidateId);
  }

  // Extraction can yield the same address or number twice from one page — a
  // German and an English rendering, or two passes over the same PDF. They are
  // distinct candidates but one fact, and a traveller shown the same number
  // twice reasonably concludes the list is unreliable. Collapse them, keeping
  // the earliest reviewed entry and the union of the venues they resolved to.
  const merged = new Map<string, PublishedLostFoundChannel>();
  for (const channel of channels) {
    const key = [
      channel.kind,
      channel.contactValue ?? channel.formAction ?? channel.pageUrl,
      channel.pageUrl,
    ].join("\0");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, channel);
      continue;
    }
    existing.venueIds = [
      ...new Set([...existing.venueIds, ...channel.venueIds]),
    ].sort();
    if (channel.verifiedAt < existing.verifiedAt) {
      existing.verifiedAt = channel.verifiedAt;
      existing.reviewDueAt = channel.reviewDueAt;
      existing.verifiedBy = channel.verifiedBy;
    }
  }

  // A page that publishes dozens of contacts is a staff or department
  // directory, not a way to reach the venue about a lost item: one municipal
  // FAQ contributed 137 numbers to a single memorial. Keeping every one of them
  // buries the useful entry, so each page contributes a few at most, preferring
  // anything that names lost property and then the organisation's general
  // mailbox over an individual's line.
  // Mailboxes that belong to the organisation but answer a different question.
  // A press office or a data protection officer will not help somebody who left
  // a coat behind, and listing them alongside the reception number makes the
  // whole list look untrusted.
  const WRONG_DEPARTMENT =
    /^(presse|press|media|datenschutz|privacy|webmaster|jobs?|bewerbung|karriere|career|spenden|donation|abo|newsletter|marketing|sponsor|redaktion)[.\-_]?[a-z]*@/i;
  const PER_PAGE_LIMIT = 3;
  const lostProperty = /fundb(?:ü|u)ro|fundsache|fundstelle|verlust|lost/i;
  const generalMailbox = /^(info|kontakt|contact|service|mail|office|post)@/i;
  const rank = (channel: PublishedLostFoundChannel): number => {
    if (lostProperty.test(`${channel.pageUrl} ${channel.contactValue ?? ""}`)) return 0;
    if (FORM_KINDS.has(channel.kind)) return 1;
    if (generalMailbox.test(channel.contactValue ?? "")) return 2;
    return 3;
  };
  const perPage = new Map<string, PublishedLostFoundChannel[]>();
  for (const channel of merged.values()) {
    if (
      !lostProperty.test(channel.contactValue ?? "") &&
      WRONG_DEPARTMENT.test(channel.contactValue ?? "")
    ) {
      continue;
    }
    perPage.set(channel.pageUrl, [
      ...(perPage.get(channel.pageUrl) ?? []),
      channel,
    ]);
  }
  const kept: PublishedLostFoundChannel[] = [];
  for (const pageChannels of perPage.values()) {
    if (pageChannels.length <= PER_PAGE_LIMIT) {
      kept.push(...pageChannels);
      continue;
    }
    kept.push(
      ...pageChannels
        .sort(
          (left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id)
        )
        .slice(0, PER_PAGE_LIMIT)
    );
  }

  const deduplicated = kept.sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  return {
    version: CHANNEL_REGISTRY_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    channels: deduplicated,
  };
}
