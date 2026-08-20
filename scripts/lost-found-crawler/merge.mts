import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CandidateFile,
  ChannelCandidate,
  DiscoveryCheckpoint,
} from "./schemas";
import { candidateUrlIdentity } from "./discovery.mjs";
import { stableId } from "./hash.mjs";

function normalizedFormAction(candidate: ChannelCandidate): string {
  const value = candidate.form?.formAction;
  if (!value) return candidateUrlIdentity(candidate.pageUrl);
  try {
    return candidateUrlIdentity(new URL(value, candidate.pageUrl).toString());
  } catch {
    return value.trim().toLowerCase();
  }
}

/**
 * A destination is independent of the crawl scope that happened to find it.
 * Keeping this identity separate from venue ownership lets one reviewed
 * endpoint cover every venue that independently reached the exact same page,
 * email, phone or form action.
 */
export function candidateEndpointIdentity(candidate: ChannelCandidate): string {
  const pageUrl = candidateUrlIdentity(candidate.pageUrl);
  if (candidate.contactValue) {
    const value =
      candidate.kind === "phone"
        ? candidate.contactValue.replace(/\D/g, "")
        : candidate.contactValue.trim().toLowerCase();
    return ["contact", pageUrl, candidate.kind, value].join("\0");
  }
  if (candidate.form) {
    const semanticFields = candidate.form.fields
      .filter((field) => field.control !== "hidden")
      .map((field) => field.semanticKey)
      .sort();
    return [
      "form",
      pageUrl,
      candidate.form.formMethod,
      normalizedFormAction(candidate),
      semanticFields.join(","),
    ].join("\0");
  }
  return ["page", pageUrl].join("\0");
}

function mergeCandidate(
  existing: ChannelCandidate,
  incoming: ChannelCandidate
): ChannelCandidate {
  const operatorId =
    existing.operatorId === incoming.operatorId ? existing.operatorId : undefined;
  const venueIds = [
    ...new Set([...existing.venueIds, ...incoming.venueIds]),
  ].sort();
  const sourcePlaceIds = [
    ...new Set([
      ...(existing.sourcePlaceIds ?? []),
      ...(incoming.sourcePlaceIds ?? []),
    ]),
  ].sort();
  const conflictingKind = existing.kind !== incoming.kind;
  return {
    ...existing,
    operatorId,
    venueIds,
    sourcePlaceIds: sourcePlaceIds.length ? sourcePlaceIds : undefined,
    canonicalizationStatus:
      venueIds.length > 0
        ? "mapped"
        : existing.canonicalizationStatus ?? incoming.canonicalizationStatus,
    kind: conflictingKind ? "manual_review" : existing.kind,
    confidence: conflictingKind
      ? Math.min(existing.confidence, incoming.confidence, 60)
      : Math.max(existing.confidence, incoming.confidence),
    reasons: [
      ...new Set([
        ...existing.reasons,
        ...incoming.reasons,
        ...(conflictingKind
          ? ["conflicting endpoint classifications require review"]
          : []),
      ]),
    ],
    evidence: [
      ...new Map(
        [...existing.evidence, ...incoming.evidence].map((evidence) => [
          `${evidence.sourceUrl}|${evidence.contentHash}`,
          evidence,
        ])
      ).values(),
    ],
    reviewStatus:
      conflictingKind ||
      existing.reviewStatus === "needs_review" ||
      incoming.reviewStatus === "needs_review"
        ? "needs_review"
        : existing.reviewStatus,
  };
}

export async function mergeCandidateFiles(options: {
  inputPaths: string[];
  outputPath: string;
}): Promise<CandidateFile> {
  if (!options.inputPaths.length) throw new Error("No candidate files supplied");
  const byEndpoint = new Map<string, ChannelCandidate>();
  const failures: CandidateFile["failures"] = [];
  const completedScopes = new Map<string, DiscoveryCheckpoint>();
  for (const inputPath of options.inputPaths) {
    const file = JSON.parse(await readFile(inputPath, "utf8")) as CandidateFile;
    if (file.version !== 1) throw new Error(`Unsupported candidate file ${inputPath}`);
    for (const candidate of file.candidates) {
      const endpointIdentity = candidateEndpointIdentity(candidate);
      const canonicalCandidate = {
        ...candidate,
        id: stableId("channel", endpointIdentity),
      };
      const existing = byEndpoint.get(endpointIdentity);
      byEndpoint.set(
        endpointIdentity,
        existing ? mergeCandidate(existing, canonicalCandidate) : canonicalCandidate
      );
    }
    failures.push(...file.failures);
    for (const checkpoint of file.completedScopes ?? []) {
      const existing = completedScopes.get(checkpoint.scopeId);
      if (!existing || checkpoint.completedAt > existing.completedAt) {
        completedScopes.set(checkpoint.scopeId, checkpoint);
      }
    }
  }
  const output: CandidateFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    candidates: [...byEndpoint.values()].sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.pageUrl.localeCompare(right.pageUrl)
    ),
    failures: [
      ...new Map(
        failures.map((failure) => [
          `${failure.seedUrl}|${failure.error}`,
          failure,
        ])
      ).values(),
    ],
    completedScopes: [...completedScopes.values()].sort((left, right) =>
      left.scopeId.localeCompare(right.scopeId)
    ),
  };
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}
