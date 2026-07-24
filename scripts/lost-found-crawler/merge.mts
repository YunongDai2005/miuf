import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CandidateFile, ChannelCandidate } from "./schemas";

function mergeCandidate(
  existing: ChannelCandidate,
  incoming: ChannelCandidate
): ChannelCandidate {
  const operatorId =
    existing.operatorId === incoming.operatorId ? existing.operatorId : undefined;
  return {
    ...existing,
    operatorId,
    venueIds: [...new Set([...existing.venueIds, ...incoming.venueIds])].sort(),
    confidence: Math.max(existing.confidence, incoming.confidence),
    reasons: [...new Set([...existing.reasons, ...incoming.reasons])],
    evidence: [
      ...new Map(
        [...existing.evidence, ...incoming.evidence].map((evidence) => [
          `${evidence.sourceUrl}|${evidence.contentHash}`,
          evidence,
        ])
      ).values(),
    ],
    reviewStatus:
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
  const byId = new Map<string, ChannelCandidate>();
  const failures: CandidateFile["failures"] = [];
  for (const inputPath of options.inputPaths) {
    const file = JSON.parse(await readFile(inputPath, "utf8")) as CandidateFile;
    if (file.version !== 1) throw new Error(`Unsupported candidate file ${inputPath}`);
    for (const candidate of file.candidates) {
      const existing = byId.get(candidate.id);
      byId.set(candidate.id, existing ? mergeCandidate(existing, candidate) : candidate);
    }
    failures.push(...file.failures);
  }
  const output: CandidateFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    candidates: [...byId.values()].sort(
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
  };
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}
