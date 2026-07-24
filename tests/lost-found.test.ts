import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PARTIES,
  partyIdForOperator,
  resolveParties,
} from "../app/lost-found/parties";
import { buildIndex } from "../app/lost-found/data";
import {
  buildReportDrafts,
  calendarReminderHref,
} from "../app/lost-found/report";
import { loadCase } from "../app/lost-found/storage";
import { addCalendarDays, berlinDateKey } from "../app/lost-found/time";
import { emptyCase, type ItineraryEntry } from "../app/lost-found/types";
import {
  blockerForStep,
  hasSearchDestination,
  isItemReady,
} from "../app/lost-found/progress";

test("uses the Berlin calendar date around a summer UTC day boundary", () => {
  assert.equal(berlinDateKey(new Date("2026-07-22T22:30:00Z")), "2026-07-23");
  assert.equal(addCalendarDays("2026-03-29", 1), "2026-03-30");
  assert.equal(addCalendarDays("2026-01-01", -1), "2025-12-31");
});

test("keeps users out of empty contact and report steps", () => {
  const lostCase = emptyCase();
  assert.equal(isItemReady(lostCase), false);
  assert.equal(blockerForStep(1, lostCase)?.step, 0);

  lostCase.item.description = "Black backpack";
  assert.equal(isItemReady(lostCase), true);
  assert.equal(blockerForStep(1, lostCase), null);
  assert.equal(hasSearchDestination(lostCase), false);
  assert.equal(blockerForStep(2, lostCase)?.step, 1);

  lostCase.item.includeCentralOffice = true;
  assert.equal(hasSearchDestination(lostCase), true);
  assert.equal(blockerForStep(3, lostCase), null);
});

test("routes documents to police and embassy guidance before lost-property offices", () => {
  const resolved = resolveParties([], "documents");
  assert.equal(resolved[0].party.id, "documents");
  assert.equal(resolved[0].party.guidanceOnly, true);
  assert.match(resolved[0].party.nextStep ?? "", /police immediately/i);
  assert.ok(resolved[0].party.relatedLinks?.some((link) => /embassy/i.test(link.label)));
});

test("uses the actual VBB operator instead of guessing regional trains belong to DB", () => {
  assert.equal(
    partyIdForOperator({
      id: "ostdeutsche-eisenbahn-gmbh",
      name: "Ostdeutsche Eisenbahn GmbH",
    }),
    "odeg"
  );
  const resolved = resolveParties([
    {
      uid: "re1",
      kind: "line",
      refId: "rail:RE1",
      label: "RE1",
      mode: "rail",
      operators: [
        {
          id: "ostdeutsche-eisenbahn-gmbh",
          name: "Ostdeutsche Eisenbahn GmbH",
        },
      ],
    },
  ]);
  assert.ok(resolved.some((entry) => entry.party.id === "odeg"));
  assert.ok(!resolved.some((entry) => entry.party.id === "db"));
  assert.ok(!resolved.some((entry) => entry.party.id === "zentral"));
});

test("keeps an exact GTFS operator homepage when its lost-property form is not curated yet", () => {
  const resolved = resolveParties([
    {
      uid: "bus",
      kind: "line",
      refId: "bus:824",
      label: "824",
      mode: "bus",
      operators: [
        {
          id: "32",
          name: "Oberhavel Verkehrsgesellschaft mbH",
          website: "https://www.ovg-online.de",
        },
      ],
    },
  ]);
  const operator = resolved.find((entry) => entry.party.id === "operator:32");
  assert.ok(operator);
  assert.equal(operator.party.website, "https://www.ovg-online.de");
  assert.equal(operator.party.verified, false);
  assert.ok(!resolved.some((entry) => entry.party.id === "bvg"));
});

test("creates a separate venue contact when offline public data has an official website", () => {
  const resolved = resolveParties([
    {
      uid: "museum",
      kind: "venue",
      refId: "node/123",
      label: "Example Museum",
      category: "museum",
      officialWebsite: "https://museum.example/",
      officialEmail: "lost@museum.example",
      contactSourceUrl: "https://www.openstreetmap.org/node/123",
      contactUpdatedAt: "2026-07-24",
    },
  ]);
  const venue = resolved.find((entry) => entry.party.id === "venue:node/123");
  assert.ok(venue);
  assert.equal(venue.party.website, "https://museum.example/");
  assert.equal(venue.party.verified, false);
  assert.ok(!resolved.some((entry) => entry.party.id === "zentral"));
});

test("adds Berlin central lost property only when the traveller selects the public or unsure-location route", () => {
  const itinerary: ItineraryEntry[] = [
    {
      uid: "museum",
      kind: "venue",
      refId: "node/123",
      label: "Example Museum",
      category: "museum",
      officialWebsite: "https://museum.example/",
    },
  ];
  assert.ok(
    !resolveParties(itinerary).some((entry) => entry.party.id === "zentral")
  );
  const withCentral = resolveParties(itinerary, null, true);
  const central = withCentral.find((entry) => entry.party.id === "zentral");
  assert.ok(central);
  assert.match(central.reasons[0], /street|taxi/i);
});

test("keeps one reviewed venue channel primary and exposes other reviewed channels as backups", () => {
  const resolved = resolveParties([
    {
      uid: "museum",
      kind: "venue",
      refId: "node/123",
      label: "Example Museum",
      category: "museum",
      lostFoundChannels: [
        {
          id: "museum-lost-form",
          venueIds: ["node/123"],
          kind: "dedicated_lost_found_form",
          scope: "venue",
          pageUrl: "https://museum.example/lost",
          language: ["en"],
          fields: [],
          captcha: false,
          loginRequired: false,
          submissionMode: "open_only",
          verifiedAt: "2026-07-24",
          verifiedBy: "Reviewer",
          evidence: [],
          contentHash: "primary",
        },
        {
          id: "museum-contact",
          venueIds: ["node/123"],
          kind: "general_contact_form",
          scope: "venue",
          pageUrl: "https://museum.example/contact",
          language: ["en"],
          fields: [],
          captcha: false,
          loginRequired: false,
          submissionMode: "open_only",
          verifiedAt: "2026-07-24",
          verifiedBy: "Reviewer",
          evidence: [],
          contentHash: "fallback",
        },
        {
          id: "museum-old-phone",
          venueIds: ["node/123"],
          kind: "phone",
          scope: "venue",
          pageUrl: "https://museum.example/old-contact",
          contactValue: "+49 30 123456",
          language: ["en"],
          fields: [],
          captcha: false,
          loginRequired: false,
          submissionMode: "open_only",
          verifiedAt: "2020-01-01",
          reviewDueAt: "2020-04-01",
          verifiedBy: "Reviewer",
          evidence: [],
          contentHash: "expired",
        },
      ],
    },
  ]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].party.id, "channel:museum-lost-form");
  assert.equal(resolved[0].party.channelId, "museum-lost-form");
  assert.equal(resolved[0].party.formUrl, "https://museum.example/lost");
  assert.deepEqual(
    resolved[0].party.alternativeChannels?.map((channel) => channel.id),
    ["museum-contact"]
  );
});

test("uses the reviewed contact value for an email-only venue channel", () => {
  const [resolved] = resolveParties([
    {
      uid: "gallery",
      kind: "venue",
      refId: "node/456",
      label: "Example Gallery",
      category: "museum",
      officialPhone: "+49 30 000000",
      lostFoundChannels: [
        {
          id: "gallery-email",
          venueIds: ["node/456"],
          kind: "email",
          scope: "venue",
          pageUrl: "https://gallery.example/lost-property",
          contactValue: "lost@gallery.example",
          language: ["en"],
          fields: [],
          captcha: false,
          loginRequired: false,
          submissionMode: "open_only",
          verifiedAt: "2026-07-24",
          verifiedBy: "Reviewer",
          evidence: [],
          contentHash: "email-page",
        },
      ],
    },
  ]);
  assert.equal(resolved.party.email, "lost@gallery.example");
  assert.equal(resolved.party.phone, undefined);
  assert.equal(resolved.party.fieldSources.phone, undefined);
  assert.equal(resolved.party.formUrl, undefined);
  assert.equal(resolved.party.formLabel, "Open reviewed official source");
  assert.equal(resolved.party.channelId, "gallery-email");
  assert.equal(resolved.party.channelKind, "email");
});

test("keeps an unreviewed venue email out of a reviewed phone channel", () => {
  const [resolved] = resolveParties([
    {
      uid: "memorial",
      kind: "venue",
      refId: "node/789",
      label: "Example Memorial",
      category: "memorial",
      officialEmail: "general@example.invalid",
      lostFoundChannels: [
        {
          id: "memorial-phone",
          venueIds: ["node/789"],
          kind: "phone",
          scope: "venue",
          pageUrl: "https://memorial.example/lost-property",
          contactValue: "+49 (0) 30 200 766 0",
          language: ["de"],
          fields: [],
          captcha: false,
          loginRequired: false,
          submissionMode: "open_only",
          verifiedAt: "2026-07-24",
          verifiedBy: "Reviewer",
          evidence: [],
          contentHash: "phone-page",
        },
      ],
    },
  ]);
  assert.equal(resolved.party.phone, "+49 (0) 30 200 766 0");
  assert.equal(resolved.party.email, undefined);
  assert.equal(resolved.party.fieldSources.email, undefined);
  assert.equal(resolved.party.channelKind, "phone");
});

test("venue guidance mentions only the manual checks present on the form", () => {
  const [resolved] = resolveParties([
    {
      uid: "tower",
      kind: "venue",
      refId: "node/tower",
      label: "Example Tower",
      category: "viewpoint",
      lostFoundChannels: [
        {
          id: "tower-contact",
          venueIds: ["node/tower"],
          kind: "general_contact_form",
          scope: "venue",
          pageUrl: "https://tower.example/contact",
          language: ["en"],
          fields: [
            {
              label: "Terms",
              control: "checkbox",
              required: true,
              step: 1,
              semanticKey: "privacyConsent",
              semanticConfidence: 0.9,
              evidenceSelector: "#terms",
            },
          ],
          captcha: false,
          loginRequired: false,
          submissionMode: "assisted_fill",
          verifiedAt: "2026-07-24",
          verifiedBy: "Reviewer",
          evidence: [],
          contentHash: "contact",
        },
      ],
    },
  ]);
  assert.match(resolved.party.nextStep ?? "", /Complete consent yourself/);
  assert.doesNotMatch(resolved.party.nextStep ?? "", /CAPTCHA/);
});

test("quick-add chooses Berlin's central Siegessäule rather than a distant same-name monument", () => {
  const index = buildIndex([], {
    source: "test",
    sourceUrl: "https://example.test",
    license: "test",
    attractions: [
      {
        id: "outside",
        name: "Siegessäule",
        category: "memorial",
        point: [52.40319, 13.09347],
      },
      {
        id: "tiergarten",
        name: "Siegessäule",
        category: "memorial",
        point: [52.51451, 13.35011],
      },
    ],
  });
  assert.equal(
    index.quickVenues.find((venue) => venue.label === "Siegessäule")?.refId,
    "tiergarten"
  );
});

test("prefers the exact memorial reception phone and keeps the general form as backup", async () => {
  const attractions = JSON.parse(
    await readFile(
      new URL("../public/berlin-attractions.json", import.meta.url),
      "utf8"
    )
  ) as Parameters<typeof buildIndex>[1];
  const registry = JSON.parse(
    await readFile(
      new URL("../public/berlin-lost-found-channels.json", import.meta.url),
      "utf8"
    )
  ) as NonNullable<Parameters<typeof buildIndex>[3]>;
  const index = buildIndex([], attractions, {}, registry);
  const memorial = index.items.find(
    (item) => item.refId === "way/172234733"
  );
  assert.deepEqual(
    memorial?.lostFoundChannels?.map((channel) => channel.kind),
    ["phone", "general_contact_form"]
  );

  const separateMemorial = index.items.find(
    (item) => item.refId === "node/13951345000"
  );
  assert.deepEqual(
    separateMemorial?.lostFoundChannels?.map((channel) => channel.kind),
    ["general_contact_form"]
  );
});

test("uses the planetarium policy email first and keeps its central phone as backup", async () => {
  const attractions = JSON.parse(
    await readFile(
      new URL("../public/berlin-attractions.json", import.meta.url),
      "utf8"
    )
  ) as Parameters<typeof buildIndex>[1];
  const registry = JSON.parse(
    await readFile(
      new URL("../public/berlin-lost-found-channels.json", import.meta.url),
      "utf8"
    )
  ) as NonNullable<Parameters<typeof buildIndex>[3]>;
  const index = buildIndex([], attractions, {}, registry);
  for (const venueId of [
    "relation/2309788",
    "relation/2309795",
    "relation/8102166",
  ]) {
    const venue = index.items.find((item) => item.refId === venueId);
    assert.deepEqual(
      venue?.lostFoundChannels?.map((channel) => channel.kind),
      ["email", "phone"]
    );
    assert.equal(
      venue?.lostFoundChannels?.[0].contactValue,
      "info@planetarium.berlin"
    );
    assert.match(venue?.lostFoundChannels?.[0].pageUrl ?? "", /\.pdf$/);
  }
});

test("retains journey details and includes category plus description in both reports", () => {
  const entry: ItineraryEntry = {
    uid: "u5-trip",
    kind: "line",
    refId: "subway:U5",
    label: "U5",
    sublabel: "Hauptbahnhof – Hönow",
    mode: "subway",
    journeys: [
      {
        from: "Berlin Hauptbahnhof",
        to: "Alexanderplatz",
        departure: "2026-07-23T23:42:00+02:00",
        direction: "Hönow",
      },
    ],
  };
  const lostCase = emptyCase();
  lostCase.item = {
    category: "bag",
    description: "black Fjällräven backpack with a panda charm",
    lostDate: "2026-07-23",
    timeFrom: "23:30",
    timeTo: "00:15",
  };
  lostCase.itinerary = [entry];
  const bvg = resolveParties(lostCase.itinerary, lostCase.item.category).find(
    (resolved) => resolved.party.id === "bvg"
  );
  assert.ok(bvg);
  const drafts = buildReportDrafts(lostCase, bvg);
  assert.match(drafts.de, /Tasche \/ Gepäck — black Fjällräven backpack/);
  assert.match(drafts.en, /Bag \/ luggage — black Fjällräven backpack/);
  assert.match(drafts.de, /23:42 · Berlin Hauptbahnhof → Alexanderplatz · Richtung Hönow/);
  assert.match(drafts.en, /23:42 · Berlin Hauptbahnhof → Alexanderplatz · direction Hönow/);
  assert.match(drafts.subject, /Bag \/ luggage/);
  assert.ok(!/\bblac…/.test(drafts.subject), drafts.subject);
});

test("migrates a valid old line entry that is missing its mode", () => {
  const previousWindow = globalThis.window;
  const raw = JSON.stringify({
    version: 1,
    itinerary: [
      {
        uid: "old-u5",
        kind: "line",
        refId: "subway:U5",
        label: "U5",
      },
      {
        uid: "broken",
        kind: "line",
        refId: 42,
        label: "bad",
      },
    ],
    submissions: {
      bvg: {
        partyId: "bvg",
        fingerprint: "old-fingerprint",
        status: "user_confirmed",
        updatedAt: "2026-07-23T10:00:00Z",
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: () => raw } },
  });
  try {
    const loaded = loadCase();
    assert.equal(loaded.itinerary.length, 1);
    assert.equal(loaded.itinerary[0].mode, "subway");
    assert.equal(loaded.submissions.bvg.length, 1);
    assert.equal(
      loaded.submissions.bvg[0].fingerprint,
      "old-fingerprint"
    );
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  }
});

test("every published party detail has a verification date and official source", () => {
  const fields = [
    "scope",
    "website",
    "formUrl",
    "email",
    "phone",
    "address",
    "hours",
    "retention",
    "nextStep",
    "note",
  ] as const;
  for (const party of Object.values(PARTIES)) {
    assert.equal(party.verified, true, party.id);
    assert.match(party.lastVerifiedAt, /^20\d{2}-\d{2}-\d{2}$/);
    for (const field of fields) {
      if (party[field]) {
        assert.match(party.fieldSources[field] ?? "", /^https:\/\//, `${party.id}.${field}`);
      }
    }
  }
});

test("creates a device-local follow-up reminder from the office timing", () => {
  const lostCase = emptyCase();
  lostCase.item.lostDate = "2026-07-23";
  const bvg = resolveParties(
    [{ uid: "u5", kind: "line", refId: "subway:U5", label: "U5", mode: "subway" }],
    "bag"
  ).find((resolved) => resolved.party.id === "bvg");
  assert.ok(bvg);
  const reminder = calendarReminderHref(
    lostCase,
    bvg,
    new Date("2026-07-23T12:00:00Z")
  );
  assert.ok(reminder);
  assert.match(reminder.filename, /2026-07-26/);
  assert.match(decodeURIComponent(reminder.href), /DTSTART;VALUE=DATE:20260726/);
});

test("ships a lightweight first-load line index without route geometry", async () => {
  const raw = await readFile(new URL("../public/berlin-lines.json", import.meta.url), "utf8");
  assert.ok(Buffer.byteLength(raw) < 60_000, `line index was ${Buffer.byteLength(raw)} bytes`);
  const index = JSON.parse(raw);
  assert.ok(index.lines.length > 300);
  assert.equal(index.lines[0].polylines, undefined);
  assert.equal(index.lines[0].stops, undefined);
  assert.ok(index.operators && Object.keys(index.operators).length > 5);
});
