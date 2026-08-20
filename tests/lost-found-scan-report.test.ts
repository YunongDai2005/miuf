import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateReviewVersion } from "../lib/channel-review";
import {
  buildVenueEndpointScanReport,
  candidateHasLostPropertyEvidence,
} from "../scripts/lost-found-crawler/scan-report.mjs";
import type {
  CandidateFile,
  ChannelCandidate,
  InventoryFile,
} from "../scripts/lost-found-crawler/schemas";

function candidate(input: {
  id: string;
  venueId: string;
  kind?: ChannelCandidate["kind"];
  reasons?: string[];
  form?: boolean;
}): ChannelCandidate {
  return {
    id: input.id,
    venueIds: [input.venueId],
    kind: input.kind ?? "manual_review",
    pageUrl: `https://${input.venueId}.example/contact`,
    form: input.form
      ? {
          pageUrl: `https://${input.venueId}.example/contact`,
          formAction: `https://${input.venueId}.example/send`,
          formMethod: "POST",
          title: "Contact",
          contextText: "Contact form",
          language: ["en"],
          fields: [
            {
              label: "Message",
              control: "textarea",
              required: true,
              step: 1,
              semanticKey: "messageBody",
              semanticConfidence: 1,
              evidenceSelector: "textarea",
            },
          ],
          captcha: false,
          loginRequired: false,
          contentHash: `${input.id}-form`,
        }
      : undefined,
    confidence: 70,
    reasons: input.reasons ?? ["official contact page"],
    discoveryPath: [
      { url: `https://${input.venueId}.example/`, label: "official" },
    ],
    evidence: [
      {
        sourceUrl: `https://${input.venueId}.example/contact`,
        contentHash: `${input.id}-evidence`,
        observedAt: "2026-07-26T00:00:00.000Z",
      },
    ],
    fetchStatus: "ok",
    reviewStatus: "candidate",
    discoveredAt: "2026-07-26T00:00:00.000Z",
  };
}

test("exports one explicit endpoint status for every venue in the inventory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "endpoint-scan-"));
  const inventoryPath = join(directory, "inventory.json");
  const candidatePath = join(directory, "candidates.json");
  const registryPath = join(directory, "registry.json");
  const reviewPath = join(directory, "reviews.json");
  const outputPath = join(directory, "scan.json");
  const venueIds = [
    "reviewed",
    "lost-candidate",
    "contact-candidate",
    "scanned-empty",
    "pending",
    "parent",
    "no-source",
  ];
  const inventory: InventoryFile = {
    version: 1,
    generatedAt: "2026-07-26T00:00:00.000Z",
    sourceFile: "fixture",
    operators: [],
    entityGroups: venueIds.map((venueId) => ({
      id: `entity:${venueId}`,
      canonicalVenueId: venueId,
      venueIds: [venueId],
      reason: "single",
    })),
    venues: venueIds.map((venueId, index) => ({
      venueId,
      venueName: venueId,
      category: "museum",
      point: [52.5 + index * 0.001, 13.4],
      entityGroupId: `entity:${venueId}`,
      canonicalVenueId: venueId,
      officialWebsite: index < 5 ? `https://${venueId}.example/` : undefined,
      parentVenueCandidateId: venueId === "parent" ? "reviewed" : undefined,
      parentCandidateDistanceMeters: venueId === "parent" ? 30 : undefined,
      resolutionStatus:
        venueId === "parent"
          ? "parent_venue_required"
          : index < 5
            ? "independent_candidate"
            : "insufficient_source",
      confidence: index < 5 ? 0.8 : 0.2,
      evidenceUrls: [],
    })),
    summary: {
      totalVenues: 7,
      independentCandidates: 5,
      parentVenueRequired: 1,
      insufficientSource: 1,
      explicitOperators: 0,
      officialWebsites: 5,
      duplicateGroups: 0,
      parentCandidates: 1,
    },
  };
  const reviewedCandidate = candidate({
    id: "reviewed-channel",
    venueId: "reviewed",
    kind: "email",
    reasons: ["page explicitly mentions lost property"],
  });
  reviewedCandidate.contactValue = "lost@reviewed.example";
  const rejectedCandidate = candidate({
    id: "rejected-contact",
    venueId: "scanned-empty",
    kind: "general_contact_form",
    form: true,
  });
  const candidates: CandidateFile = {
    version: 1,
    generatedAt: "2026-07-26T00:00:00.000Z",
    candidates: [
      reviewedCandidate,
      candidate({
        id: "lost-page",
        venueId: "lost-candidate",
        reasons: ["page explicitly mentions lost property"],
      }),
      candidate({
        id: "contact-form",
        venueId: "contact-candidate",
        kind: "general_contact_form",
        form: true,
      }),
      rejectedCandidate,
    ],
    failures: [],
    completedScopes: [
      {
        scopeId: "scope",
        origin: "https://fixture.example",
        venueIds: [
          "reviewed",
          "lost-candidate",
          "contact-candidate",
          "scanned-empty",
        ],
        completedAt: "2026-07-26T00:00:00.000Z",
      },
    ],
  };
  await writeFile(inventoryPath, JSON.stringify(inventory));
  await writeFile(candidatePath, JSON.stringify(candidates));
  await writeFile(
    reviewPath,
    JSON.stringify({
      version: 1,
      decisions: [
        {
          candidateId: rejectedCandidate.id,
          decision: "reject",
          reviewedAt: "2026-07-26T12:00:00.000Z",
          reviewedBy: "Reviewer",
          reviewedCandidateVersion: candidateReviewVersion(rejectedCandidate),
        },
      ],
    })
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      generatedAt: "2026-07-26T00:00:00.000Z",
      channels: [
        {
          id: "reviewed-channel",
          venueIds: ["reviewed"],
          kind: "email",
          scope: "venue",
          pageUrl: "https://reviewed.example/lost",
          contactValue: "lost@reviewed.example",
          language: ["en"],
          fields: [],
          captcha: false,
          loginRequired: false,
          submissionMode: "open_only",
          verifiedAt: "2026-07-26T00:00:00.000Z",
          reviewDueAt: "2026-10-24T00:00:00.000Z",
          verifiedBy: "Reviewer",
          evidence: reviewedCandidate.evidence,
          contentHash: "reviewed-channel-evidence",
        },
      ],
    })
  );
  const report = await buildVenueEndpointScanReport({
    inventoryPath,
    candidatePaths: [candidatePath],
    registryPath,
    reviewPath,
    outputPath,
    now: new Date("2026-07-27T00:00:00.000Z"),
  });
  assert.deepEqual(
    Object.fromEntries(report.records.map((record) => [record.venueId, record.status])),
    {
      reviewed: "reviewed_endpoint",
      "lost-candidate": "lost_found_candidate",
      "contact-candidate": "official_contact_candidate",
      "scanned-empty": "scanned_no_endpoint",
      pending: "pending_scan",
      parent: "parent_venue_candidate",
      "no-source": "no_official_source",
    }
  );
  assert.equal(report.records.length, inventory.venues.length);
  assert.equal(report.summary.rejectedCandidates, 1);
  assert.equal(
    report.records.find((record) => record.venueId === "reviewed")?.endpoints
      .length,
    1
  );
  assert.equal(
    report.records.find((record) => record.venueId === "contact-candidate")
      ?.bestEndpoint?.formAction,
    "https://contact-candidate.example/send"
  );
  assert.equal(
    JSON.parse(await readFile(outputPath, "utf8")).records.length,
    inventory.venues.length
  );
});

test("does not mistake a plain official contact page for lost-property evidence", () => {
  assert.equal(
    candidateHasLostPropertyEvidence(
      candidate({ id: "plain", venueId: "venue", form: true })
    ),
    false
  );
  assert.equal(
    candidateHasLostPropertyEvidence(
      candidate({
        id: "lost",
        venueId: "venue",
        reasons: ["page explicitly mentions lost property"],
      })
    ),
    true
  );
});
