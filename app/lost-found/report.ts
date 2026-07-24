import { ITEM_CATEGORY_META, type LostCase } from "./types";
import type { ResolvedParty } from "./parties";
import { addCalendarDays, berlinDateKey, berlinTimeLabel } from "./time";

export interface ReportDrafts {
  de: string;
  en: string;
  subject: string;
}

export function preferredReportLanguage(
  resolved: ResolvedParty
): "de" | "en" {
  const languages = resolved.party.languages ?? [];
  return languages.includes("en") && !languages.includes("de") ? "en" : "de";
}

export function reportBodyForParty(
  drafts: ReportDrafts,
  resolved: ResolvedParty
): string {
  return preferredReportLanguage(resolved) === "en" ? drafts.en : drafts.de;
}

function timeRange(item: LostCase["item"]): string {
  const from = item.timeFrom?.trim();
  const to = item.timeTo?.trim();
  if (from && to) return `${from}–${to}`;
  if (from) return `ab ${from}`;
  if (to) return `bis ${to}`;
  return "";
}

const CATEGORY_DE: Record<NonNullable<LostCase["item"]["category"]>, string> = {
  bag: "Tasche / Gepäck",
  wallet: "Geldbörse",
  phone: "Mobiltelefon",
  electronics: "Elektronisches Gerät",
  documents: "Dokumente / Ausweis",
  keys: "Schlüssel",
  camera: "Kamera",
  clothing: "Kleidungsstück",
  other: "Sonstiger Gegenstand",
};

function journeyContext(
  entry: ResolvedParty["entries"][number],
  language: "de" | "en"
): string[] {
  if (!entry.journeys?.length) return [entry.label];
  return entry.journeys.map((journey) => {
    const time = journey.departure ? berlinTimeLabel(journey.departure) : null;
    const route =
      journey.from && journey.to
        ? `${journey.from} → ${journey.to}`
        : journey.from
          ? `${language === "de" ? "ab" : "from"} ${journey.from}`
          : journey.to
            ? `${language === "de" ? "bis" : "to"} ${journey.to}`
            : "";
    const direction = journey.direction
      ? `${language === "de" ? "Richtung" : "direction"} ${journey.direction}`
      : "";
    return [entry.label, time, route, direction].filter(Boolean).join(" · ");
  });
}

/** Where the item was likely lost, phrased for one specific office. */
function contextParts(resolved: ResolvedParty): { de: string; en: string } {
  const lineEntries = resolved.entries.filter((entry) => entry.kind === "line");
  const bits: string[] = lineEntries.flatMap((entry) =>
    journeyContext(entry, "de").map((detail) => `Linie/Fahrt: ${detail}`)
  );
  if (!bits.length && resolved.lines.length) bits.push(`Linie(n): ${resolved.lines.join(", ")}`);
  if (resolved.venues.length) bits.push(`Ort(e): ${resolved.venues.join(", ")}`);
  const enBits: string[] = lineEntries.flatMap((entry) =>
    journeyContext(entry, "en").map((detail) => `line/journey: ${detail}`)
  );
  if (!enBits.length && resolved.lines.length) enBits.push(`line(s): ${resolved.lines.join(", ")}`);
  if (resolved.venues.length) enBits.push(`place(s): ${resolved.venues.join(", ")}`);
  return {
    de: bits.join(" · ") || "im öffentlichen Nahverkehr in Berlin",
    en: enBits.join(" · ") || "public transport in Berlin",
  };
}

function truncateAtWord(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const candidate = value.slice(0, maxLength + 1);
  const boundary = candidate.lastIndexOf(" ");
  return `${candidate.slice(0, boundary > maxLength * 0.6 ? boundary : maxLength).trimEnd()}…`;
}

/** Build ready-to-send lost-property report text in German and English. */
export function buildReportDrafts(lostCase: LostCase, resolved: ResolvedParty): ReportDrafts {
  const { item, contact } = lostCase;
  const desc = item.description.trim();
  const catEn = item.category ? ITEM_CATEGORY_META[item.category].label : "";
  const catDe = item.category ? CATEGORY_DE[item.category] : "";
  const nounDe = [catDe, desc].filter(Boolean).join(" — ") || "verlorener Gegenstand";
  const nounEn = [catEn, desc].filter(Boolean).join(" — ") || "lost item";
  const range = timeRange(item);
  const ctx = contextParts(resolved);

  const subjectItem = truncateAtWord(
    [catEn, desc].filter(Boolean).join(" — ") || "Gegenstand",
    72
  );
  const subject = `Verlustmeldung – ${subjectItem} (${item.lostDate})`;

  const name = contact.name.trim();
  const email = contact.email.trim();
  const phone = contact.phone?.trim();
  const itemDetailsDe = [
    item.brand?.trim() ? `Marke: ${item.brand.trim()}` : null,
    item.color?.trim() ? `Farbe: ${item.color.trim()}` : null,
    item.identifyingFeatures?.trim()
      ? `Besondere Merkmale: ${item.identifyingFeatures.trim()}`
      : null,
    item.estimatedValue?.trim() ? `Ungefährer Wert: ${item.estimatedValue.trim()}` : null,
  ].filter((value): value is string => Boolean(value));
  const itemDetailsEn = [
    item.brand?.trim() ? `Brand: ${item.brand.trim()}` : null,
    item.color?.trim() ? `Colour: ${item.color.trim()}` : null,
    item.identifyingFeatures?.trim()
      ? `Identifying features: ${item.identifyingFeatures.trim()}`
      : null,
    item.estimatedValue?.trim() ? `Approximate value: ${item.estimatedValue.trim()}` : null,
  ].filter((value): value is string => Boolean(value));

  const de = [
    "Sehr geehrte Damen und Herren,",
    "",
    "ich möchte einen verlorenen Gegenstand melden und bitte um Ihre Hilfe.",
    "",
    `Gegenstand: ${nounDe}`,
    ...itemDetailsDe,
    `Verlustdatum: ${item.lostDate}${range ? ` (${range} Uhr)` : ""}`,
    `Vermuteter Ort: ${ctx.de}`,
    "",
    "Bitte benachrichtigen Sie mich, falls der Gegenstand gefunden wurde oder abgegeben wird.",
    "",
    "Meine Kontaktdaten:",
    name ? `Name: ${name}` : null,
    email ? `E-Mail: ${email}` : null,
    phone ? `Telefon: ${phone}` : null,
    contact.postalAddress?.trim()
      ? `Anschrift: ${contact.postalAddress.trim()}`
      : null,
    "",
    "Vielen Dank für Ihre Unterstützung.",
    "Mit freundlichen Grüßen,",
    name || "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  const en = [
    "Dear Sir or Madam,",
    "",
    "I would like to report a lost item and kindly ask for your help.",
    "",
    `Item: ${nounEn}`,
    ...itemDetailsEn,
    `Date lost: ${item.lostDate}${range ? ` (${range})` : ""}`,
    `Likely location: ${ctx.en}`,
    "",
    "Please let me know if the item has been found or handed in.",
    "",
    "My contact details:",
    name ? `Name: ${name}` : null,
    email ? `Email: ${email}` : null,
    phone ? `Phone: ${phone}` : null,
    contact.postalAddress?.trim()
      ? `Postal address: ${contact.postalAddress.trim()}`
      : null,
    "",
    "Thank you very much for your help.",
    "Kind regards,",
    name || "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  return { de, en, subject };
}

/** A mailto: link that pre-fills a real mail client — no backend required. */
export function mailtoLink(email: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(body)}`;
}

function escapeIcs(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

/** A device-local calendar download; no case details are sent to a service. */
export function calendarReminderHref(
  lostCase: LostCase,
  resolved: ResolvedParty,
  now = new Date()
): { href: string; filename: string } | null {
  const days = resolved.party.followUpAfterDays;
  if (!days) return null;
  const today = berlinDateKey(now);
  const baseDate =
    lostCase.item.lostDate > today ? lostCase.item.lostDate : today;
  const date = addCalendarDays(baseDate, days);
  const dateCompact = date.replaceAll("-", "");
  const title = `Follow up: ${resolved.party.name}`;
  const description = [
    resolved.party.nextStep,
    `Lost item: ${
      [
        lostCase.item.category
          ? ITEM_CATEGORY_META[lostCase.item.category].label
          : "",
        lostCase.item.description.trim(),
      ]
        .filter(Boolean)
        .join(" — ") || "not described"
    }`,
    resolved.party.formUrl || resolved.party.website,
  ]
    .filter(Boolean)
    .join("\n");
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Berlin Lost and Found//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${resolved.party.id}-${lostCase.item.lostDate}@berlin-lost-found.local`,
    `DTSTART;VALUE=DATE:${dateCompact}`,
    `DTEND;VALUE=DATE:${addCalendarDays(date, 1).replaceAll("-", "")}`,
    `SUMMARY:${escapeIcs(title)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  return {
    href: `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`,
    filename: `follow-up-${resolved.party.id.replace(/[^a-z0-9_-]+/gi, "-")}-${date}.ics`,
  };
}
