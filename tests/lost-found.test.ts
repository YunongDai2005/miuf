import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PARTIES, resolveParties } from "../app/lost-found/parties";
import {
  buildReportDrafts,
  calendarReminderHref,
} from "../app/lost-found/report";
import { loadCase } from "../app/lost-found/storage";
import { addCalendarDays, berlinDateKey } from "../app/lost-found/time";
import { emptyCase, type ItineraryEntry } from "../app/lost-found/types";

test("uses the Berlin calendar date around a summer UTC day boundary", () => {
  assert.equal(berlinDateKey(new Date("2026-07-22T22:30:00Z")), "2026-07-23");
  assert.equal(addCalendarDays("2026-03-29", 1), "2026-03-30");
  assert.equal(addCalendarDays("2026-01-01", -1), "2025-12-31");
});

test("routes documents to police and embassy guidance before lost-property offices", () => {
  const resolved = resolveParties([], "documents");
  assert.equal(resolved[0].party.id, "documents");
  assert.equal(resolved[0].party.guidanceOnly, true);
  assert.match(resolved[0].party.nextStep ?? "", /police immediately/i);
  assert.ok(resolved[0].party.relatedLinks?.some((link) => /embassy/i.test(link.label)));
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
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: () => raw } },
  });
  try {
    const loaded = loadCase();
    assert.equal(loaded.itinerary.length, 1);
    assert.equal(loaded.itinerary[0].mode, "subway");
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
});
