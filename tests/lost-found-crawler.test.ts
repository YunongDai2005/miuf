import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFormGuide } from "../app/lost-found/formGuide";
import { buildAutofillPackage } from "../app/lost-found/autofill";
import type { ResolvedParty } from "../app/lost-found/parties";
import { emptyCase } from "../app/lost-found/types";
import {
  isChannelReviewCurrent,
  isPublishedChannelRegistry,
} from "../lib/lost-found-channel-schema";
import {
  nextSubmissionRecord,
  submissionFingerprint,
} from "../app/lost-found/submission";
import { extractFormsFromHtml } from "../scripts/lost-found-crawler/form-extractor.mjs";
import { mergeFormSnapshots } from "../scripts/lost-found-crawler/browser.mjs";
import {
  buildDiscoverySeedGroups,
  extractPublicContactValues,
} from "../scripts/lost-found-crawler/discovery.mjs";
import type { InventoryFile } from "../scripts/lost-found-crawler/schemas";
import { isForbiddenIp } from "../scripts/lost-found-crawler/safe-fetch.mjs";
import { scoreCandidate } from "../scripts/lost-found-crawler/scoring.mjs";
import {
  pageEvidenceFromHtml,
  pageEvidenceHash,
} from "../scripts/lost-found-crawler/page-evidence.mjs";
import {
  exportExtensionAdapters,
  publishReviewedChannels,
} from "../scripts/lost-found-crawler/publish.mjs";
import { isUnexpectedVerificationRedirect } from "../scripts/lost-found-crawler/verify.mjs";

test("extracts a dedicated German form without retaining current values", async () => {
  const html = await readFile(
    new URL(
      "../scripts/lost-found-crawler/fixtures/dedicated-de.html",
      import.meta.url
    ),
    "utf8"
  );
  const [form] = extractFormsFromHtml({
    html,
    pageUrl: "https://museum.example/fundbuero",
  });
  assert.ok(form);
  assert.equal(form.formMethod, "POST");
  assert.equal(form.formAction, "https://museum.example/fundservice/senden");
  assert.equal(form.fields.find((field) => field.rawName === "verlustdatum")?.semanticKey, "lossDate");
  assert.equal(form.fields.find((field) => field.rawName === "verlustort")?.semanticKey, "lossLocation");
  assert.equal(form.fields.find((field) => field.rawName === "email")?.semanticKey, "email");
  assert.equal(form.fields.find((field) => field.rawName === "privacy")?.semanticKey, "privacyConsent");
  assert.doesNotMatch(JSON.stringify(form), /secret@example|must-not-be-stored/);

  const scored = scoreCandidate({
    url: "https://museum.example/fundbuero",
    title: form.title,
    text: "Gegenstand verloren Verlustmeldung",
    form,
    linkedFromOfficialSeed: true,
  });
  assert.equal(scored.kind, "dedicated_lost_found_form");
  assert.ok(scored.confidence >= 70);
});

test("treats an ordinary contact form as a reviewable fallback, not a lost form", () => {
  const [form] = extractFormsFromHtml({
    pageUrl: "https://museum.example/kontakt",
    html: `
      <html lang="de"><head><title>Kontakt</title></head><body>
      <main><h1>Kontakt</h1><form><label for="mail">E-Mail</label>
      <input id="mail" type="email" required><label for="message">Nachricht</label>
      <textarea id="message"></textarea></form></main></body></html>
    `,
  });
  assert.ok(form);
  const scored = scoreCandidate({
    url: "https://museum.example/kontakt",
    title: form.title,
    text: "Kontakt",
    form,
    linkedFromOfficialSeed: true,
  });
  assert.equal(scored.kind, "general_contact_form");
  assert.ok(scored.confidence <= 60);
  assert.equal(
    form.fields.find((field) => field.control === "textarea")?.semanticKey,
    "messageBody"
  );
});

test("does not claim a general contact form exists when only a contact page was found", () => {
  const scored = scoreCandidate({
    url: "https://museum.example/contact",
    title: "Contact",
    text: "Visitor service contact details",
    linkedFromOfficialSeed: true,
  });
  assert.equal(scored.kind, "manual_review");
});

test("page evidence ignores changing navigation while retaining main-content changes", () => {
  const snapshot = (body: string, nav: string) =>
    pageEvidenceHash(
      pageEvidenceFromHtml(
        `<html><head><title>Lost property</title></head><body><nav>${nav}</nav><main>${body}</main></body></html>`
      )
    );
  assert.equal(snapshot("Report a lost bag", "Summer tickets"), snapshot("Report a lost bag", "Winter tickets"));
  assert.notEqual(snapshot("Report a lost bag", "Menu"), snapshot("The service is closed", "Menu"));
});

test("verification tolerates a trailing slash but flags a moved or cross-domain form", () => {
  assert.equal(
    isUnexpectedVerificationRedirect(
      "https://museum.example/lost",
      "https://museum.example/lost/"
    ),
    false
  );
  assert.equal(
    isUnexpectedVerificationRedirect(
      "https://museum.example/lost",
      "https://museum.example/login"
    ),
    true
  );
  assert.equal(
    isUnexpectedVerificationRedirect(
      "https://museum.example/lost",
      "https://forms.example/lost"
    ),
    true
  );
});

test("runtime registry validation rejects malformed adapter channels and review deadlines expire", () => {
  const channel = {
    id: "channel",
    venueIds: ["venue"],
    kind: "dedicated_lost_found_form",
    scope: "venue",
    pageUrl: "https://museum.example/lost",
    language: ["en"],
    fields: [],
    captcha: false,
    loginRequired: false,
    submissionMode: "adapter",
    verifiedAt: "2026-07-23T00:00:00Z",
    reviewDueAt: "2026-10-21T00:00:00Z",
    verifiedBy: "Reviewer",
    evidence: [],
    contentHash: "hash",
  };
  assert.equal(
    isPublishedChannelRegistry({
      version: 1,
      generatedAt: "2026-07-23T00:00:00Z",
      channels: [channel],
    }),
    false
  );
  assert.equal(
    isChannelReviewCurrent(channel, new Date("2026-10-20T23:59:59Z")),
    true
  );
  assert.equal(
    isChannelReviewCurrent(channel, new Date("2026-10-22T00:00:00Z")),
    false
  );
});

test("keeps the form fingerprint stable when a framework regenerates element ids", () => {
  const formForId = (id: string) =>
    extractFormsFromHtml({
      pageUrl: "https://forms.example/lost",
      html: `<form method="post"><label for="${id}">Verlustort *</label><input id="${id}"></form>`,
    })[0];
  const first = formForId("k-68f8c88d-4744-410f-8bfd-74fc5e8f45c4");
  const second = formForId("k-f5e06f6a-6e88-4fc8-9d3c-136927601b67");
  assert.equal(first.fields[0].required, true);
  assert.equal(first.contentHash, second.contentHash);
});

test("merges multiple rendered steps into one channel form", () => {
  const state = (field: string, label: string, step: number) => {
    const form = extractFormsFromHtml({
      pageUrl: "https://forms.example/lost",
      html: `<html><head><title>Lost report</title></head><body><form method="post" action="/lost"><label>${label}<input name="${field}"></label></form></body></html>`,
    })[0];
    return {
      ...form,
      fields: form.fields.map((entry) => ({ ...entry, step })),
    };
  };
  const merged = mergeFormSnapshots([
    state("lossDate", "Verlustdatum", 1),
    state("description", "Beschreibung", 2),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(
    merged[0].fields.map((field) => [field.rawName, field.step]),
    [
      ["lossDate", 1],
      ["description", 2],
    ]
  );
});

test("recognises a form-like group of lost-property controls without a form tag", () => {
  const forms = extractFormsFromHtml({
    pageUrl: "https://forms.example/lost",
    html: `<main><h1>Verlustmeldung</h1><div role="form">
      <label>Verlustdatum <input name="loss-date" type="date"></label>
      <label>Verlustort <input name="loss-location"></label>
      <label>Beschreibung <textarea name="description"></textarea></label>
    </div></main>`,
  });
  assert.equal(forms.length, 1);
  assert.equal(forms[0].formMethod, "POST");
  assert.equal(forms[0].fields.length, 3);
});

test("interprets a plain Name field as first name when the same form also asks for surname", () => {
  const [form] = extractFormsFromHtml({
    pageUrl: "https://forms.example/contact",
    html: `<form><label>Name <input name="name"></label><label>Surname <input name="surname"></label></form>`,
  });
  assert.deepEqual(
    form.fields.map((field) => field.semanticKey),
    ["firstName", "lastName"]
  );
});

test("keeps same-domain venues isolated unless an explicit operator website joins them", () => {
  const inventory = {
    version: 1,
    generatedAt: "2026-07-24T00:00:00Z",
    sourceFile: "fixture",
    operators: [],
    entityGroups: [
      {
        id: "entity-a",
        canonicalVenueId: "a",
        venueIds: ["a", "a-duplicate"],
        reason: "near_duplicate",
      },
      {
        id: "entity-b",
        canonicalVenueId: "b",
        venueIds: ["b"],
        reason: "single",
      },
      {
        id: "entity-c",
        canonicalVenueId: "c",
        venueIds: ["c"],
        reason: "single",
      },
      {
        id: "entity-d",
        canonicalVenueId: "d",
        venueIds: ["d"],
        reason: "single",
      },
    ],
    venues: [
      {
        venueId: "a",
        venueName: "Department A",
        category: "museum",
        point: [52.5, 13.4],
        entityGroupId: "entity-a",
        canonicalVenueId: "a",
        officialWebsite: "https://portal.example/a",
        resolutionStatus: "independent_candidate",
        confidence: 0.6,
        evidenceUrls: [],
      },
      {
        venueId: "b",
        venueName: "Department B",
        category: "museum",
        point: [52.51, 13.4],
        entityGroupId: "entity-b",
        canonicalVenueId: "b",
        officialWebsite: "https://portal.example/b",
        resolutionStatus: "independent_candidate",
        confidence: 0.6,
        evidenceUrls: [],
      },
      ...["c", "d"].map((venueId) => ({
        venueId,
        venueName: `Operator venue ${venueId}`,
        category: "museum",
        point: [52.52, 13.4] as [number, number],
        entityGroupId: `entity-${venueId}`,
        canonicalVenueId: venueId,
        operatorId: "operator-shared",
        operatorName: "Shared operator",
        operatorWebsite: "https://operator.example/",
        resolutionStatus: "independent_candidate" as const,
        confidence: 0.85,
        evidenceUrls: [],
      })),
    ],
    summary: {
      totalVenues: 4,
      independentCandidates: 4,
      parentVenueRequired: 0,
      insufficientSource: 0,
      explicitOperators: 1,
      officialWebsites: 2,
      duplicateGroups: 1,
      parentCandidates: 0,
    },
  } satisfies InventoryFile;
  const groups = buildDiscoverySeedGroups(inventory);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups
      .filter((group) => group.origin === "https://portal.example")
      .map((group) => [...group.venueIds].sort()),
    [
      ["a", "a-duplicate"],
      ["b"],
    ]
  );
  assert.deepEqual(
    [...groups.find((group) => group.origin === "https://operator.example")!.venueIds].sort(),
    ["c", "d"]
  );
});

test("extracts public email and phone links from main content without footer contacts", () => {
  const contacts = extractPublicContactValues(`
    <body>
      <main>
        <h1>Fundbüro</h1>
        <a href="mailto:fundbuero%40museum.example?subject=Lost">Email</a>
        <a href="tel:+49%2030%20123-456">Call</a>
      </main>
      <footer><a href="mailto:press@museum.example">Press</a></footer>
    </body>
  `);
  assert.deepEqual(
    contacts.map(({ kind, value }) => ({ kind, value })),
    [
      { kind: "email", value: "fundbuero@museum.example" },
      { kind: "phone", value: "+49 30 123-456" },
    ]
  );
});

test("blocks local and private network destinations", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fd00::1",
  ]) {
    assert.equal(isForbiddenIp(address), true, address);
  }
  assert.equal(isForbiddenIp("1.1.1.1"), false);
  assert.equal(isForbiddenIp("2606:4700:4700::1111"), false);
});

test("builds a field-by-field guide but leaves consent to the traveller", () => {
  const lostCase = emptyCase();
  lostCase.item.category = "bag";
  lostCase.item.description = "Black backpack with a panda charm";
  lostCase.item.lostDate = "2026-07-23";
  lostCase.contact = {
    name: "Ada Lovelace",
    email: "ada@example.test",
    phone: "+49 30 123",
  };
  const fields = [
    {
      label: "Verlustdatum",
      control: "date" as const,
      required: true,
      step: 1,
      semanticKey: "lossDate" as const,
      semanticConfidence: 0.9,
      evidenceSelector: "#date",
    },
    {
      label: "Datenschutz",
      control: "checkbox" as const,
      required: true,
      step: 1,
      semanticKey: "privacyConsent" as const,
      semanticConfidence: 0.9,
      evidenceSelector: "#privacy",
    },
  ];
  const resolved = {
    party: {
      id: "venue:test",
      channelId: "channel_test",
      name: "Museum",
      operatorName: "Museum",
      scope: "Museum",
      website: "https://museum.example",
      formUrl: "https://museum.example/lost",
      verified: true,
      lastVerifiedAt: "2026-07-23",
      fieldSources: {},
      formFields: fields,
      submissionMode: "assisted_fill",
    },
    reasons: [],
    lines: [],
    venues: ["Museum"],
    entries: [],
  } satisfies ResolvedParty;
  const guide = buildFormGuide(lostCase, resolved);
  assert.equal(guide[0].suggestedValue, "2026-07-23");
  assert.equal(guide[1].suggestedValue, undefined);
  assert.equal(guide[1].needsUserInput, true);

  const autofill = buildAutofillPackage(
    lostCase,
    resolved,
    new Date("2026-07-23T12:00:00Z")
  );
  assert.ok(autofill);
  assert.equal(autofill.submitAllowed, false);
  assert.equal(autofill.channelId, "channel_test");
  assert.equal(autofill.fields.length, 1);
  assert.equal(autofill.fields[0].value, "2026-07-23");
  assert.deepEqual(
    autofill.manualRequiredFields.map((field) => field.label),
    ["Datenschutz"]
  );
  assert.equal(autofill.expiresAt, "2026-07-23T14:00:00.000Z");
});

test("fingerprints exact reports and records local receipt evidence", () => {
  const lostCase = emptyCase();
  lostCase.item.description = "Black backpack";
  const resolved = {
    party: {
      id: "venue:test",
      name: "Museum",
      operatorName: "Museum",
      scope: "Museum",
      website: "https://museum.example",
      formUrl: "https://museum.example/lost",
      verified: true,
      lastVerifiedAt: "2026-07-23",
      fieldSources: {},
    },
    reasons: [],
    lines: [],
    venues: ["Museum"],
    entries: [],
  } satisfies ResolvedParty;
  const first = submissionFingerprint(lostCase, resolved);
  assert.equal(first, submissionFingerprint(lostCase, resolved));
  lostCase.item.description = "Blue backpack";
  assert.notEqual(first, submissionFingerprint(lostCase, resolved));
  const record = nextSubmissionRecord({
    partyId: resolved.party.id,
    fingerprint: first,
    status: "receipt_confirmed",
    receipt: " CASE-123 ",
    now: new Date("2026-07-23T12:00:00Z"),
  });
  assert.equal(record.receipt, "CASE-123");
  assert.equal(record.updatedAt, "2026-07-23T12:00:00.000Z");
});

test("publishes only reviewed candidates and refuses an untested submit adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lost-found-publish-"));
  const candidatePath = join(directory, "candidates.json");
  const reviewPath = join(directory, "reviews.json");
  const adapterPath = join(directory, "adapters.json");
  const outputPath = join(directory, "registry.json");
  const extensionOutputPath = join(directory, "adapters.js");
  const candidate = {
    id: "channel_test",
    venueIds: ["venue/1"],
    kind: "dedicated_lost_found_form" as const,
    pageUrl: "https://museum.example/lost",
    form: {
      pageUrl: "https://museum.example/lost",
      formAction: "https://museum.example/lost",
      formMethod: "POST" as const,
      title: "Lost property",
      contextText: "Report lost property",
      language: ["en"],
      fields: [
        {
          label: "Email",
          control: "email" as const,
          required: true,
          step: 1,
          semanticKey: "email" as const,
          semanticConfidence: 0.99,
          evidenceSelector: "#email",
        },
      ],
      captcha: false,
      loginRequired: false,
      contentHash: "form-hash",
    },
    confidence: 90,
    reasons: ["official"],
    discoveryPath: [
      { url: "https://museum.example", label: "official website" },
    ],
    evidence: [
      {
        sourceUrl: "https://museum.example/lost",
        contentHash: "evidence-hash",
        observedAt: "2026-07-23T10:00:00Z",
      },
    ],
    fetchStatus: "ok" as const,
    reviewStatus: "candidate" as const,
    discoveredAt: "2026-07-23T10:00:00Z",
  };
  await writeFile(
    candidatePath,
    JSON.stringify({
      version: 1,
      generatedAt: "2026-07-23T10:00:00Z",
      candidates: [candidate],
      failures: [],
    })
  );
  await writeFile(adapterPath, JSON.stringify({ version: 1, adapters: [] }));
  await writeFile(
    reviewPath,
    JSON.stringify({
      version: 1,
      decisions: [
        {
          candidateId: candidate.id,
          decision: "accept",
          reviewedAt: "2026-07-23T11:00:00Z",
          reviewedBy: "Test reviewer",
          submissionMode: "adapter",
          adapterId: "missing-adapter",
        },
      ],
    })
  );
  await assert.rejects(
    publishReviewedChannels({
      candidatePath,
      reviewPath,
      adapterPath,
      outputPath,
    }),
    /matching tested adapter/
  );
  await writeFile(
    reviewPath,
    JSON.stringify({
      version: 1,
      decisions: [
        {
          candidateId: candidate.id,
          decision: "accept",
          reviewedAt: "2026-07-23T11:00:00Z",
          reviewedBy: "Test reviewer",
          submissionMode: "assisted_fill",
        },
      ],
    })
  );
  const registry = await publishReviewedChannels({
    candidatePath,
    reviewPath,
    adapterPath,
    outputPath,
  });
  assert.equal(registry.channels.length, 1);
  assert.equal(registry.channels[0].submissionMode, "assisted_fill");
  assert.equal(registry.channels[0].verifiedBy, "Test reviewer");
  assert.equal(registry.channels[0].reviewDueAt, "2026-10-21T11:00:00.000Z");
  assert.equal(isPublishedChannelRegistry(registry), true);

  await writeFile(
    adapterPath,
    JSON.stringify({
      version: 1,
      adapters: [
        {
          id: "experimental-adapter",
          channelId: candidate.id,
          origin: "https://museum.example",
          pathPattern: "^/lost$",
          testedContentHash: "form-hash",
          submitSelector: "button[type=submit]",
        },
      ],
    })
  );
  assert.equal(
    await exportExtensionAdapters({
      adapterPath,
      registryPath: outputPath,
      outputPath: extensionOutputPath,
    }),
    0
  );
  assert.doesNotMatch(
    await readFile(extensionOutputPath, "utf8"),
    /experimental-adapter/
  );
});
