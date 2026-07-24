import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { buildFormGuide } from "../app/lost-found/formGuide";
import { buildAutofillPackage } from "../app/lost-found/autofill";
import type { ResolvedParty } from "../app/lost-found/parties";
import { emptyCase } from "../app/lost-found/types";
import {
  isChannelReviewCurrent,
  isPublishedChannelRegistry,
} from "../lib/lost-found-channel-schema";
import {
  candidateReviewVersion,
  createReviewDecision,
  reviewEventIsNewer,
} from "../lib/channel-review";
import {
  nextSubmissionRecord,
  submissionRecordFromOutcome,
  submissionFingerprint,
} from "../app/lost-found/submission";
import { extractFormsFromHtml } from "../scripts/lost-found-crawler/form-extractor.mjs";
import { mergeFormSnapshots } from "../scripts/lost-found-crawler/browser.mjs";
import {
  buildDiscoverySeedGroups,
  candidateUrlIdentity,
  extractOfficialVenueContactValues,
  extractPublicContactValues,
  formCandidateId,
  isRelevantDiscoveredForm,
  shouldSkipDiscoveryUrl,
} from "../scripts/lost-found-crawler/discovery.mjs";
import { buildInventory } from "../scripts/lost-found-crawler/inventory.mjs";
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
import { selectRefreshedForm } from "../scripts/lost-found-crawler/refresh.mjs";
import { verifiedDateLabel } from "../app/lost-found/ui";

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

test("hides bot-trap fields without claiming that the user must solve a CAPTCHA", () => {
  const [form] = extractFormsFromHtml({
    pageUrl: "https://museum.example/contact",
    html: `
      <html lang="en"><body><form>
        <label for="name">Your name</label><input id="name" name="name" required>
        <label for="message">Your message</label><textarea id="message" name="message" required></textarea>
        <label for="trap">Don't fill this field!</label>
        <input id="trap" name="tx_powermail_pi1[field][__hp]">
      </form></body></html>
    `,
  });
  assert.ok(form);
  const trap = form.fields.find((field) => field.rawId === "trap");
  assert.equal(trap?.control, "hidden");
  assert.equal(form.captcha, false);
});

test("hides a German bot-trap whose negation follows the verb", () => {
  const [form] = extractFormsFromHtml({
    pageUrl: "https://museum.example/kontakt",
    html: `<form>
      <textarea name="message" aria-label="Nachricht"></textarea>
      <label for="trap">Bitte fülle dieses Feld nicht aus.</label>
      <input id="trap" name="input_8">
    </form>`,
  });
  assert.equal(
    form.fields.find((field) => field.rawId === "trap")?.control,
    "hidden"
  );
});

test("keeps a visible security question as a manual CAPTCHA", () => {
  const [form] = extractFormsFromHtml({
    pageUrl: "https://museum.example/contact",
    html: `
      <html lang="en"><body><form>
        <label for="message">Message</label><textarea id="message"></textarea>
        <label for="check">Security test: 2+3 equals? *</label>
        <input id="check" name="number-1" type="number" required>
        <label for="trap">Please do not fill in this field.</label>
        <input id="trap" name="input_8">
      </form></body></html>
    `,
  });
  assert.ok(form);
  assert.equal(form.captcha, true);
  assert.equal(
    form.fields.find((field) => field.rawId === "trap")?.control,
    "hidden"
  );
  assert.equal(
    form.fields.find((field) => field.rawId === "check")?.control,
    "number"
  );
});

test("recognises Friendly Captcha but ignores invisible reCAPTCHA v3", () => {
  const [friendly] = extractFormsFromHtml({
    pageUrl: "https://museum.example/contact",
    html: `<form>
      <input name="name" aria-label="Your name">
      <textarea name="message" aria-label="Message"></textarea>
      <div class="frc-captcha"><iframe src="https://global.frcapi.com/api/v2/captcha/widget"></iframe></div>
    </form>`,
  });
  const [invisible] = extractFormsFromHtml({
    pageUrl: "https://museum.example/contact",
    html: `<form>
      <input name="name" aria-label="Your name">
      <textarea name="message" aria-label="Message"></textarea>
      <div class="elementor-field-type-recaptcha_v3 recaptcha_v3-bottomright"></div>
      <div class="elementor-g-recaptcha" data-size="invisible"></div>
    </form>`,
  });
  assert.equal(friendly.captcha, true);
  assert.equal(invisible.captcha, false);
});

test("refresh matches the reviewed form by fields when several forms share an action", () => {
  const [newsletter, contact] = extractFormsFromHtml({
    pageUrl: "https://museum.example/contact",
    html: `
      <form action="/contact"><input name="email" type="email"></form>
      <form action="/contact">
        <input name="email" type="email">
        <textarea name="message" aria-label="Message"></textarea>
      </form>
    `,
  });
  assert.ok(newsletter);
  assert.ok(contact);
  assert.equal(selectRefreshedForm(contact, [newsletter, contact]), contact);
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

test("bundled reviewed registry covers 33 venues without publishing bot traps", async () => {
  const registry = JSON.parse(
    await readFile(
      new URL("../public/berlin-lost-found-channels.json", import.meta.url),
      "utf8"
    )
  );
  assert.equal(isPublishedChannelRegistry(registry), true);
  assert.equal(registry.channels.length, 6);
  assert.equal(
    new Set(registry.channels.flatMap((channel: { venueIds: string[] }) => channel.venueIds))
      .size,
    33
  );
  assert.equal(
    registry.channels.some((channel: { fields: Array<{ rawName?: string; label: string }> }) =>
      channel.fields.some((field) =>
        /__hp|do not fill|nicht ausfüllen|nicht ausfuellen/i.test(
          `${field.rawName ?? ""} ${field.label}`
        )
      )
    ),
    false
  );
  assert.equal(
    registry.channels.filter(
      (channel: { submissionMode: string }) =>
        channel.submissionMode === "assisted_fill"
    ).length,
    4
  );
  assert.equal(
    registry.channels.some(
      (channel: { submissionMode: string }) =>
        channel.submissionMode === "adapter"
    ),
    false
  );
});

test("verification badges accept both date-only and reviewed timestamps", () => {
  assert.equal(
    verifiedDateLabel("2026-07-24"),
    "source checked · 24 Jul 2026"
  );
  assert.equal(
    verifiedDateLabel("2026-07-24T09:30:00.000Z"),
    "source checked · 24 Jul 2026"
  );
  assert.equal(verifiedDateLabel("not-a-date"), "source checked");
});

test("older database review events cannot override a newer bundled review", () => {
  const current = {
    candidateId: "channel",
    decision: "accept" as const,
    reviewedAt: "2026-07-24T09:31:23.016Z",
    reviewedBy: "Reviewer",
    reviewedCandidateVersion: "version",
  };
  assert.equal(
    reviewEventIsNewer(current, "2026-07-24 09:30:00"),
    false
  );
  assert.equal(
    reviewEventIsNewer(current, "2026-07-24 09:32:00"),
    true
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

test("keeps the form fingerprint stable across a trailing slash and tracking query", () => {
  const html = `<form method="post">
    <input type="email" name="email" aria-label="Email">
    <textarea name="message" aria-label="Message"></textarea>
  </form>`;
  const [plain] = extractFormsFromHtml({
    pageUrl: "https://museum.example/contact",
    html,
  });
  const [variant] = extractFormsFromHtml({
    pageUrl: "https://museum.example/contact/?utm_source=newsletter",
    html,
  });
  assert.equal(plain.contentHash, variant.contentHash);
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

test("normalises required message and consent labels for safe contact-form guidance", () => {
  const [form] = extractFormsFromHtml({
    pageUrl: "https://museum.example/kontakt",
    html: `<form>
      <label>E-Mail *<input type="email" required></label>
      <label>Ihre Mitteilung an das Team *<textarea required></textarea></label>
      <label>Hiermit bestätige ich die Speicherung Ihrer Daten *
        <input type="checkbox" required>
      </label>
    </form>`,
  });
  assert.deepEqual(
    form.fields.map((field) => field.semanticKey),
    ["email", "messageBody", "privacyConsent"]
  );
});

test("excludes booking and feedback forms from the general-contact fallback", () => {
  const makeForm = (pageUrl: string, title: string) =>
    extractFormsFromHtml({
      pageUrl,
      html: `<title>${title}</title><form>
        <input type="email" aria-label="Email">
        <textarea aria-label="Message"></textarea>
      </form>`,
    })[0];
  assert.equal(
    isRelevantDiscoveredForm(
      makeForm("https://museum.example/contact/questions", "Contact"),
      true
    ),
    true
  );
  assert.equal(
    isRelevantDiscoveredForm(
      makeForm("https://museum.example/contact/booking/", "Group booking"),
      true
    ),
    false
  );
  assert.equal(
    isRelevantDiscoveredForm(
      makeForm("https://museum.example/contact/feedback/", "Feedback"),
      true
    ),
    false
  );
  assert.equal(
    candidateUrlIdentity("https://museum.example/contact/?utm_source=test"),
    candidateUrlIdentity("https://museum.example/contact")
  );
  assert.equal(
    formCandidateId({
      ownerScopeKey: "operator:one",
      pageUrl: "https://museum.example/contact/?utm_source=old",
      formIndex: 0,
      hasForm: true,
    }),
    formCandidateId({
      ownerScopeKey: "operator:one",
      pageUrl: "https://museum.example/contact",
      formIndex: 0,
      hasForm: true,
    })
  );
  assert.notEqual(
    formCandidateId({
      ownerScopeKey: "operator:one",
      pageUrl: "https://museum.example/contact",
      formIndex: 0,
      hasForm: true,
    }),
    formCandidateId({
      ownerScopeKey: "operator:one",
      pageUrl: "https://museum.example/contact",
      formIndex: 1,
      hasForm: true,
    })
  );
  assert.equal(
    shouldSkipDiscoveryUrl("https://museum.example/rathaus/pressemitteilungen"),
    true
  );
  assert.equal(
    shouldSkipDiscoveryUrl("https://museum.example/service/fundbuero"),
    false
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

test("official-source operator overrides safely consolidate separately listed venues", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lost-operator-"));
  const inputPath = join(directory, "attractions.json");
  const overridePath = join(directory, "operators.json");
  const outputPath = join(directory, "inventory.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      attractions: [
        {
          id: "venue-a",
          name: "Museum A",
          category: "museum",
          point: [52.5, 13.4],
          website: "https://museum-network.example/a",
          websiteSourceUrl: "https://source.example/a",
        },
        {
          id: "venue-b",
          name: "Museum B",
          category: "museum",
          point: [52.51, 13.41],
          website: "https://www.museum-network.example/b",
          websiteSourceUrl: "https://source.example/b",
        },
      ],
    })
  );
  await writeFile(
    overridePath,
    JSON.stringify({
      version: 1,
      operators: [
        {
          name: "Audited Museum Network",
          website: "https://museum-network.example/",
          matchWebsiteHosts: ["museum-network.example"],
          evidenceUrls: ["https://museum-network.example/imprint"],
          auditedAt: "2026-07-24T00:00:00Z",
        },
      ],
    })
  );

  const inventory = await buildInventory({
    inputPath,
    outputPath,
    operatorOverridePath: overridePath,
  });
  assert.equal(inventory.operators.length, 1);
  assert.equal(inventory.operators[0].resolutionSource, "official_source_audit");
  assert.deepEqual(inventory.operators[0].venueIds, ["venue-a", "venue-b"]);
  assert.ok(
    inventory.venues.every(
      (venue) =>
        venue.operatorResolutionSource === "official_source_audit" &&
        venue.confidence === 0.98
    )
  );
  const groups = buildDiscoverySeedGroups(inventory);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].origin, "https://museum-network.example");
  assert.deepEqual([...groups[0].venueIds].sort(), ["venue-a", "venue-b"]);
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

test("keeps claim-specific evidence and discovers visible phones on a dedicated page", () => {
  const contacts = extractPublicContactValues(`
    <html><head><title>Fundbüro</title></head><body><main>
      <h1>Fundbüro</h1>
      <section><h2>Haustiere, Hund oder Katze</h2>
        <p>Telefon: 030 111111</p>
        <a href="mailto:fund@museum.example">fund@museum.example</a>
      </section>
      <section><h2>Fahrrad, Handy, Schlüssel oder sonstige Gegenstände</h2>
        <p>Telefon: 030 222222</p>
        <a href="mailto:fund@museum.example">fund@museum.example</a>
      </section>
    </main></body></html>
  `);
  const email = contacts.find((contact) => contact.kind === "email");
  assert.ok(email);
  assert.match(email.excerpt, /Handy/);
  assert.ok(
    contacts.some(
      (contact) =>
        contact.kind === "phone" &&
        contact.value === "030 222222" &&
        /Gegenstände/.test(contact.excerpt)
      )
  );
  assert.equal(
    contacts.some(
      (contact) =>
        contact.kind === "phone" && contact.value === "030 111111"
    ),
    false
  );
});

test("extracts an exact venue contact fallback without leaking footer contacts", () => {
  const contacts = extractOfficialVenueContactValues(`
    <body><main>
      <h1>Heimathaus</h1><p>About the museum.</p>
      <h2>Kontakt</h2>
      <p>Dorfaue 8 · 030 6491105 oder 030 6493325</p>
      <p>heimathaus.schoeneiche@gmx.de</p>
      <h2>Öffnungszeiten</h2><p>Wednesday to Saturday</p>
    </main>
    <footer>Telefon: 030 000000 · info@municipality.example</footer></body>
  `);
  assert.deepEqual(
    contacts.map(({ kind, value }) => ({ kind, value })),
    [
      { kind: "email", value: "heimathaus.schoeneiche@gmx.de" },
      { kind: "phone", value: "030 6491105" },
      { kind: "phone", value: "030 6493325" },
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

test("maps one venue to an official select option and leaves ambiguous choices manual", () => {
  const lostCase = emptyCase();
  const baseResolved = {
    party: {
      id: "channel_smb",
      name: "SMB",
      operatorName: "SMB",
      scope: "Museum",
      website: "https://museum.example",
      formUrl: "https://museum.example/contact",
      nextStep: "Open the form",
      followUpAfterDays: 2,
      verified: true,
      lastVerifiedAt: "2026-07-24",
      fieldSources: {
        website: "https://museum.example/contact",
        formUrl: "https://museum.example/contact",
      },
      formFields: [
        {
          label: "Museum *",
          control: "select" as const,
          required: true,
          options: [
            { value: "Gemäldegalerie", label: "Gemäldegalerie" },
            { value: "Kulturforum", label: "Kulturforum" },
            { value: "Pergamonmuseum", label: "Pergamonmuseum" },
            { value: "Das Panorama", label: "Pergamonmuseum. Das Panorama" },
          ],
          step: 1,
          semanticKey: "venue" as const,
          semanticConfidence: 0.9,
          evidenceSelector: "#museum",
        },
      ],
      submissionMode: "assisted_fill" as const,
    },
    entries: [],
    lines: [],
    modes: [],
    reasons: [],
  };
  const matched = buildFormGuide(lostCase, {
    ...baseResolved,
    venues: ["Gemäldegalerie am Kulturforum"],
  } as ResolvedParty);
  assert.equal(matched[0].autofillValue, "Gemäldegalerie");
  assert.equal(matched[0].needsUserInput, false);

  const ambiguous = buildFormGuide(lostCase, {
    ...baseResolved,
    venues: ["Pergamon"],
  } as ResolvedParty);
  assert.equal(ambiguous[0].autofillValue, undefined);
  assert.equal(ambiguous[0].needsUserInput, true);
});

test("uses the reviewed form language for its suggested message", () => {
  const lostCase = emptyCase();
  lostCase.item.description = "Black backpack";
  const resolved = {
    party: {
      id: "channel_en",
      name: "Museum",
      operatorName: "Museum",
      scope: "Museum",
      website: "https://museum.example",
      formUrl: "https://museum.example/en/contact",
      nextStep: "Open the form",
      followUpAfterDays: 2,
      verified: true,
      lastVerifiedAt: "2026-07-24",
      fieldSources: {},
      languages: ["en"],
      formFields: [
        {
          label: "Message",
          control: "textarea" as const,
          required: true,
          step: 1,
          semanticKey: "messageBody" as const,
          semanticConfidence: 0.9,
          evidenceSelector: "#message",
        },
      ],
      submissionMode: "assisted_fill" as const,
    },
    entries: [],
    lines: [],
    venues: ["Museum"],
    reasons: [],
  } satisfies ResolvedParty;
  assert.match(
    buildFormGuide(lostCase, resolved)[0].suggestedValue ?? "",
    /^Dear Sir or Madam,/
  );
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
  const imported = submissionRecordFromOutcome(
    {
      version: 1,
      channelId: "channel_test",
      fingerprint: first,
      status: "receipt_confirmed",
      updatedAt: "2026-07-23T12:01:00Z",
      receipt: " CASE-456 ",
    },
    {
      partyId: resolved.party.id,
      channelId: "channel_test",
      fingerprint: first,
    }
  );
  assert.equal(imported.receipt, "CASE-456");
  assert.equal(imported.status, "receipt_confirmed");
  assert.throws(
    () =>
      submissionRecordFromOutcome(
        {
          version: 1,
          channelId: "channel_test",
          fingerprint: "another-report",
          status: "uncertain",
          updatedAt: "2026-07-23T12:01:00Z",
        },
        {
          partyId: resolved.party.id,
          channelId: "channel_test",
          fingerprint: first,
        }
      ),
    /different report/
  );
});

test("browser helper rejects a package without a bounded expiry", async () => {
  const source = await readFile(
    new URL("../extension/content.js", import.meta.url),
    "utf8"
  );
  let listener:
    | ((
        message: unknown,
        sender: unknown,
        respond: (value: unknown) => void
      ) => boolean)
    | undefined;
  vm.runInNewContext(source, {
    URL,
    location: {
      origin: "https://museum.example",
      pathname: "/lost",
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback: typeof listener) {
            listener = callback;
          },
        },
      },
    },
  });
  assert.ok(listener);
  const response = await new Promise<Record<string, unknown>>((resolve) => {
    listener!(
      {
        type: "BERLIN_LOST_FOUND_FILL",
        payload: {
          version: 1,
          channelId: "channel_test",
          pageUrl: "https://museum.example/lost",
          fingerprint: "0123456789abcdef",
          createdAt: "2026-07-23T12:00:00Z",
          submitAllowed: false,
          fields: [],
          manualRequiredFields: [],
        },
      },
      null,
      (value) => resolve(value as Record<string, unknown>)
    );
  });
  assert.equal(response.ok, false);
  assert.match(String(response.error), /validity dates/);
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
  const serverDecision = createReviewDecision({
    candidate,
    decision: "accept",
    reviewerName: "Signed-in reviewer",
    submissionMode: "assisted_fill",
    reviewedAt: "2026-07-23T10:30:00Z",
  });
  assert.equal(
    serverDecision.reviewedCandidateVersion,
    candidateReviewVersion(candidate)
  );
  assert.equal(serverDecision.reviewedContentHash, "form-hash");
  assert.throws(
    () =>
      createReviewDecision({
        candidate: { ...candidate, kind: "manual_review", form: undefined },
        decision: "accept",
        reviewerName: "Signed-in reviewer",
      }),
    /Evidence-only/
  );
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
          reviewedCandidateVersion: "stale-destination-version",
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
    /changed after its destination review/
  );
  await writeFile(
    candidatePath,
    JSON.stringify({
      version: 1,
      generatedAt: "2026-07-23T10:00:00Z",
      candidates: [
        {
          ...candidate,
          kind: "manual_review",
          form: undefined,
        },
      ],
      failures: [],
    })
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
          reviewedCandidateVersion: candidateReviewVersion({
            ...candidate,
            kind: "manual_review",
            form: undefined,
          }),
          kindOverride: "dedicated_lost_found_form",
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
    /without an extracted form/
  );
  await writeFile(
    candidatePath,
    JSON.stringify({
      version: 1,
      generatedAt: "2026-07-23T10:00:00Z",
      candidates: [candidate],
      failures: [],
    })
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
          reviewedCandidateVersion: candidateReviewVersion(candidate),
          submissionMode: "adapter",
          adapterId: "missing-adapter",
          reviewedContentHash: "form-hash",
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
          reviewedCandidateVersion: candidateReviewVersion(candidate),
          submissionMode: "assisted_fill",
          reviewedContentHash: "stale-form-hash",
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
    /form changed after its field review/
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
          reviewedCandidateVersion: candidateReviewVersion(candidate),
          submissionMode: "assisted_fill",
          reviewedContentHash: "form-hash",
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
