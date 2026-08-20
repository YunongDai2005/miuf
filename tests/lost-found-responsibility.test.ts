import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateReviewVersion } from "../lib/channel-review";
import { buildIndex } from "../app/lost-found/data";
import { resolveParties } from "../app/lost-found/parties";
import { buildPublishedChannelRegistry } from "../lib/lost-found-channel-publish";
import {
  isPublicLostFoundResponsibilityIndex,
  type PublicLostFoundResponsibilityIndex,
} from "../lib/lost-found-responsibility-schema";
import { mergeCandidateFiles } from "../scripts/lost-found-crawler/merge.mjs";
import { buildResponsibilityGraph } from "../scripts/lost-found-crawler/responsibility.mjs";
import type {
  CandidateFile,
  ChannelCandidate,
  InventoryFile,
} from "../scripts/lost-found-crawler/schemas";

const reviewedChannel = {
  id: "operator-email",
  operatorId: "op-1",
  venueIds: ["direct-a"],
  kind: "email" as const,
  scope: "operator" as const,
  pageUrl: "https://operator.example/lost-property",
  contactValue: "lost@operator.example",
  language: ["en"],
  fields: [],
  captcha: false,
  loginRequired: false,
  submissionMode: "open_only" as const,
  verifiedAt: "2026-07-25T00:00:00.000Z",
  reviewDueAt: "2026-10-23T00:00:00.000Z",
  verifiedBy: "Fixture reviewer",
  evidence: [
    {
      sourceUrl: "https://operator.example/lost-property",
      contentHash: "reviewed-evidence",
      observedAt: "2026-07-25T00:00:00.000Z",
    },
  ],
  contentHash: "reviewed-evidence",
};

async function responsibilityFixture() {
  const directory = await mkdtemp(join(tmpdir(), "responsibility-"));
  const inventoryPath = join(directory, "inventory.json");
  const registryPath = join(directory, "registry.json");
  const outputPath = join(directory, "responsibilities.json");
  const reportPath = join(directory, "coverage.json");
  const runtimePath = join(directory, "runtime.json");
  const inventory: InventoryFile = {
    version: 1,
    generatedAt: "2026-07-25T00:00:00.000Z",
    sourceFile: "fixture",
    operators: [
      {
        id: "op-1",
        name: "Audited operator",
        website: "https://operator.example/",
        venueIds: ["direct-a", "direct-b"],
        confidence: 0.98,
        resolutionSource: "official_source_audit",
        evidenceUrls: ["https://operator.example/imprint"],
        auditedAt: "2026-07-24T00:00:00.000Z",
      },
    ],
    entityGroups: ["direct-a", "direct-b", "official-c", "parent-d", "fallback-e"].map(
      (venueId) => ({
        id: `entity:${venueId}`,
        canonicalVenueId: venueId,
        venueIds: [venueId],
        reason: "single" as const,
      })
    ),
    venues: [
      ...["direct-a", "direct-b"].map((venueId, index) => ({
        venueId,
        venueName: `Operator venue ${index + 1}`,
        category: "museum",
        point: [52.5 + index * 0.001, 13.4] as [number, number],
        entityGroupId: `entity:${venueId}`,
        canonicalVenueId: venueId,
        operatorId: "op-1",
        operatorName: "Audited operator",
        operatorWebsite: "https://operator.example/",
        operatorResolutionSource: "official_source_audit" as const,
        resolutionStatus: "independent_candidate" as const,
        confidence: 0.98,
        evidenceUrls: ["https://operator.example/imprint"],
      })),
      {
        venueId: "official-c",
        venueName: "Independent museum",
        category: "museum",
        point: [52.51, 13.41],
        entityGroupId: "entity:official-c",
        canonicalVenueId: "official-c",
        officialWebsite: "https://independent.example/contact",
        resolutionStatus: "independent_candidate",
        confidence: 0.8,
        evidenceUrls: ["https://independent.example/imprint"],
      },
      {
        venueId: "parent-d",
        venueName: "Sculpture inside museum",
        category: "artwork",
        point: [52.5101, 13.4101],
        entityGroupId: "entity:parent-d",
        canonicalVenueId: "parent-d",
        parentVenueCandidateId: "official-c",
        parentCandidateDistanceMeters: 18,
        resolutionStatus: "parent_venue_required",
        confidence: 0.4,
        evidenceUrls: [],
      },
      {
        venueId: "fallback-e",
        venueName: "Unresolved landmark",
        category: "landmark",
        point: [52.52, 13.42],
        entityGroupId: "entity:fallback-e",
        canonicalVenueId: "fallback-e",
        resolutionStatus: "insufficient_source",
        confidence: 0.2,
        evidenceUrls: [],
      },
    ],
    summary: {
      totalVenues: 5,
      independentCandidates: 3,
      parentVenueRequired: 1,
      insufficientSource: 1,
      explicitOperators: 1,
      officialWebsites: 1,
      duplicateGroups: 0,
      parentCandidates: 1,
    },
  };
  await writeFile(inventoryPath, JSON.stringify(inventory));
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      generatedAt: "2026-07-25T00:00:00.000Z",
      channels: [reviewedChannel],
    })
  );
  const graph = await buildResponsibilityGraph({
    inventoryPath,
    registryPath,
    outputPath,
    reportPath,
    runtimePath,
    now: new Date("2026-07-26T00:00:00.000Z"),
  });
  return { directory, graph, reportPath, runtimePath };
}

test("resolves every venue through a conservative responsibility tier", async () => {
  const { graph, reportPath, runtimePath } = await responsibilityFixture();
  assert.deepEqual(graph.summary, {
    totalVenues: 5,
    resolvedVenues: 5,
    reviewedChannel: 1,
    officialContact: 2,
    parentCandidate: 1,
    manualGuidance: 1,
    actionableCoverageRate: 0.6,
    functionalCoverageRate: 1,
    // Coverage is also reported against the venues that could hold an office of
    // their own, separately from those that inherit one and those — sculptures,
    // plaques — that the place index carries only so a photograph can be named.
    addressableVenues: 3,
    addressableWithRoute: 2,
    addressableWithSourceOnly: 1,
    addressableRouteRate: 0.6667,
    inheritsFromParent: 1,
    noVenueOfficePossible: 1,
  });
  assert.equal(new Set(graph.assignments.map((entry) => entry.venueId)).size, 5);
  assert.equal(
    graph.assignments.find((entry) => entry.venueId === "direct-b")?.resolution,
    "audited_operator"
  );
  assert.equal(
    graph.assignments.find((entry) => entry.venueId === "parent-d")?.resolution,
    "parent_candidate"
  );
  assert.equal(
    graph.assignments.find((entry) => entry.venueId === "parent-d")?.channelIds.length,
    0
  );
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.tiers.reduce((sum: number, tier: { count: number }) => sum + tier.count, 0), 5);
  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  assert.equal(isPublicLostFoundResponsibilityIndex(runtime), true);
});

test("the app exposes parent ownership as a candidate, never as an approved form", async () => {
  const { runtimePath } = await responsibilityFixture();
  const runtime = JSON.parse(
    await readFile(runtimePath, "utf8")
  ) as PublicLostFoundResponsibilityIndex;
  const index = buildIndex(
    [],
    {
      source: "fixture",
      sourceUrl: "https://example.invalid",
      license: "fixture",
      attractions: [
        {
          id: "parent-d",
          name: "Sculpture inside museum",
          category: "artwork",
          point: [52.5101, 13.4101],
        },
        {
          id: "fallback-e",
          name: "Unresolved landmark",
          category: "landmark",
          point: [52.52, 13.42],
        },
      ],
    },
    {},
    undefined,
    runtime
  );
  const parent = index.items.find((item) => item.refId === "parent-d")!;
  const [resolvedParent] = resolveParties([
    {
      uid: "parent",
      kind: "venue",
      refId: parent.refId,
      label: parent.label,
      category: parent.category,
      lostFoundResponsibility: parent.lostFoundResponsibility,
    },
  ]);
  assert.match(resolvedParent.party.name, /Possible responsible site/);
  assert.match(resolvedParent.party.note ?? "", /Candidate only/);
  assert.equal(resolvedParent.party.formUrl, undefined);
  assert.equal(resolvedParent.party.verified, false);

  const fallback = index.items.find((item) => item.refId === "fallback-e")!;
  const [resolvedFallback] = resolveParties([
    {
      uid: "fallback",
      kind: "venue",
      refId: fallback.refId,
      label: fallback.label,
      category: fallback.category,
      lostFoundResponsibility: fallback.lostFoundResponsibility,
    },
  ]);
  assert.equal(resolvedFallback.party.id, "venues");
});

test("publishing expands an audited operator channel but excludes parent candidates", async () => {
  const { graph } = await responsibilityFixture();
  const candidate: ChannelCandidate = {
    id: reviewedChannel.id,
    operatorId: "op-1",
    venueIds: ["direct-a"],
    kind: "email",
    pageUrl: reviewedChannel.pageUrl,
    contactValue: reviewedChannel.contactValue,
    confidence: 90,
    reasons: ["reviewed operator channel"],
    discoveryPath: [{ url: "https://operator.example/", label: "official" }],
    evidence: reviewedChannel.evidence,
    fetchStatus: "ok",
    reviewStatus: "candidate",
    discoveredAt: "2026-07-25T00:00:00.000Z",
  };
  const candidates: CandidateFile = {
    version: 1,
    generatedAt: "2026-07-25T00:00:00.000Z",
    candidates: [candidate],
    failures: [],
  };
  const decision = {
    candidateId: candidate.id,
    decision: "accept" as const,
    reviewedAt: "2026-07-25T00:00:00.000Z",
    reviewedBy: "Fixture reviewer",
    reviewerKind: "human" as const,
    reviewedCandidateVersion: candidateReviewVersion(candidate),
  };
  const input = {
    candidates,
    adapters: { version: 1 as const, adapters: [] },
    responsibilities: graph,
    generatedAt: "2026-07-26T00:00:00.000Z",
  };
  const expanded = buildPublishedChannelRegistry({
    ...input,
    reviews: { version: 1, decisions: [decision] },
  });
  assert.deepEqual(expanded.channels[0].venueIds, ["direct-a", "direct-b"]);
  assert.equal(expanded.channels[0].venueIds.includes("parent-d"), false);

  const explicitlyScoped = buildPublishedChannelRegistry({
    ...input,
    reviews: {
      version: 1,
      decisions: [{ ...decision, venueIdsOverride: ["direct-a"] }],
    },
  });
  assert.deepEqual(explicitlyScoped.channels[0].venueIds, ["direct-a"]);
});

test("candidate merging preserves resumable crawl checkpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-merge-"));
  const leftPath = join(directory, "left.json");
  const rightPath = join(directory, "right.json");
  const outputPath = join(directory, "merged.json");
  const candidateFile = (completedAt: string, scopeId: string): CandidateFile => ({
    version: 1,
    generatedAt: completedAt,
    candidates: [],
    failures: [],
    completedScopes: [
      { scopeId, origin: `https://${scopeId}.example`, venueIds: [scopeId], completedAt },
    ],
  });
  await writeFile(leftPath, JSON.stringify(candidateFile("2026-07-25T00:00:00Z", "a")));
  await writeFile(
    rightPath,
    JSON.stringify({
      ...candidateFile("2026-07-26T00:00:00Z", "b"),
      completedScopes: [
        ...candidateFile("2026-07-26T00:00:00Z", "b").completedScopes!,
        ...candidateFile("2026-07-27T00:00:00Z", "a").completedScopes!,
      ],
    })
  );
  const merged = await mergeCandidateFiles({
    inputPaths: [leftPath, rightPath],
    outputPath,
  });
  assert.deepEqual(merged.completedScopes?.map((entry) => entry.scopeId), ["a", "b"]);
  assert.equal(merged.completedScopes?.[0].completedAt, "2026-07-27T00:00:00Z");
});

test("candidate merging reviews one endpoint while preserving every proven venue scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-endpoint-merge-"));
  const leftPath = join(directory, "left.json");
  const rightPath = join(directory, "right.json");
  const outputPath = join(directory, "merged.json");
  const candidate = (id: string, venueId: string, pageUrl: string): ChannelCandidate => ({
    id,
    venueIds: [venueId],
    kind: "email",
    pageUrl,
    contactValue: "fundsachen@museum.example",
    confidence: 70,
    reasons: ["page explicitly mentions lost property"],
    discoveryPath: [{ url: `https://museum.example/${venueId}`, label: "official website" }],
    evidence: [
      {
        sourceUrl: pageUrl,
        excerpt: "Fundsachen: fundsachen@museum.example",
        contentHash: `hash-${venueId}`,
        observedAt: "2026-07-28T00:00:00Z",
      },
    ],
    fetchStatus: "ok",
    reviewStatus: "candidate",
    discoveredAt: "2026-07-28T00:00:00Z",
  });
  const file = (entry: ChannelCandidate): CandidateFile => ({
    version: 1,
    generatedAt: "2026-07-28T00:00:00Z",
    candidates: [entry],
    failures: [],
  });
  await writeFile(
    leftPath,
    JSON.stringify(
      file(candidate("owner-a", "venue-a", "https://museum.example/lost/?utm_source=a"))
    )
  );
  await writeFile(
    rightPath,
    JSON.stringify(
      file(candidate("owner-b", "venue-b", "https://museum.example/lost"))
    )
  );

  const merged = await mergeCandidateFiles({
    inputPaths: [leftPath, rightPath],
    outputPath,
  });
  assert.equal(merged.candidates.length, 1);
  assert.deepEqual(merged.candidates[0].venueIds, ["venue-a", "venue-b"]);
  assert.equal(merged.candidates[0].evidence.length, 2);
  assert.match(merged.candidates[0].id, /^channel_[a-f0-9]{16}$/);
});
