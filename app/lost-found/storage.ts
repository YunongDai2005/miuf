import type { TransitMode } from "../berlin-transit/transit";
import type { TransitOperator } from "../berlin-transit/transit";
import {
  emptyCase,
  type Contact,
  type ItineraryEntry,
  type ItineraryJourney,
  type LostCase,
  type ReportState,
  type SubmissionRecord,
} from "./types";

const STORAGE_KEY = "berlin-lostfound-case-v1";
// Contact is remembered separately so it survives "Start over" and new cases.
const CONTACT_KEY = "berlin-lostfound-contact-v1";

/** Load the traveller's saved case from this device, or a blank one. */
export function loadCase(): LostCase {
  if (typeof window === "undefined") return emptyCase();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyCase();
    const parsed = JSON.parse(raw) as Partial<LostCase>;
    if (!parsed || parsed.version !== 1) return emptyCase();
    const base = emptyCase();
    return {
      ...base,
      ...parsed,
      item: { ...base.item, ...parsed.item },
      contact: { ...base.contact, ...parsed.contact },
      itinerary: sanitizeItinerary(parsed.itinerary),
      reported: sanitizeReported(parsed.reported),
      submissions: sanitizeSubmissions(parsed.submissions),
    };
  } catch {
    return emptyCase();
  }
}

const TRANSIT_MODES = new Set<TransitMode>([
  "subway",
  "light_rail",
  "tram",
  "bus",
  "rail",
  "ferry",
]);

function inferredMode(refId: string, label: string): TransitMode | undefined {
  const prefix = refId.split(":")[0] as TransitMode;
  if (TRANSIT_MODES.has(prefix)) return prefix;
  if (/^U\d/i.test(label)) return "subway";
  if (/^S\d/i.test(label)) return "light_rail";
  if (/^(RB|RE|FEX)\b/i.test(label)) return "rail";
  if (/^(M|N)?\d{1,3}$/i.test(label)) return "bus";
  return undefined;
}

function sanitizeJourneys(value: unknown): ItineraryJourney[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const journeys = value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map((entry) => ({
      from: typeof entry.from === "string" ? entry.from : undefined,
      to: typeof entry.to === "string" ? entry.to : undefined,
      departure: typeof entry.departure === "string" ? entry.departure : undefined,
      direction: typeof entry.direction === "string" ? entry.direction : undefined,
    }))
    .filter((entry) => entry.from || entry.to || entry.departure || entry.direction);
  return journeys.length ? journeys : undefined;
}

function sanitizeOperators(value: unknown): TransitOperator[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const operators = value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id.trim() : "",
      name: typeof entry.name === "string" ? entry.name.trim() : "",
    }))
    .filter((entry) => entry.id && entry.name);
  return operators.length ? operators : undefined;
}

function optionalString(entry: Record<string, unknown>, key: string): string | undefined {
  return typeof entry[key] === "string" && entry[key].trim()
    ? entry[key].trim()
    : undefined;
}

function sanitizeItinerary(value: unknown): ItineraryEntry[] {
  if (!Array.isArray(value)) return [];
  const output: ItineraryEntry[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as Record<string, unknown>;
    if (
      (entry.kind !== "line" && entry.kind !== "venue") ||
      typeof entry.uid !== "string" ||
      typeof entry.refId !== "string" ||
      typeof entry.label !== "string"
    ) {
      continue;
    }
    const mode =
      typeof entry.mode === "string" && TRANSIT_MODES.has(entry.mode as TransitMode)
        ? (entry.mode as TransitMode)
        : entry.kind === "line"
          ? inferredMode(entry.refId, entry.label)
          : undefined;
    // A line without an operator mode cannot be routed safely; malformed venue
    // entries are still harmless and useful to the traveller.
    if (entry.kind === "line" && !mode) continue;
    output.push({
      uid: entry.uid,
      kind: entry.kind,
      refId: entry.refId,
      label: entry.label,
      sublabel: typeof entry.sublabel === "string" ? entry.sublabel : undefined,
      mode,
      category:
        typeof entry.category === "string"
          ? (entry.category as ItineraryEntry["category"])
          : undefined,
      journeys: sanitizeJourneys(entry.journeys),
      operators: sanitizeOperators(entry.operators),
      officialWebsite: optionalString(entry, "officialWebsite"),
      officialPhone: optionalString(entry, "officialPhone"),
      officialEmail: optionalString(entry, "officialEmail"),
      lostFoundUrl: optionalString(entry, "lostFoundUrl"),
      contactSourceUrl: optionalString(entry, "contactSourceUrl"),
      officialWebsiteSourceUrl: optionalString(entry, "officialWebsiteSourceUrl"),
      contactUpdatedAt: optionalString(entry, "contactUpdatedAt"),
    });
  }
  return output;
}

function sanitizeReported(value: unknown): Record<string, ReportState> {
  if (!value || typeof value !== "object") return {};
  const output: Record<string, ReportState> = {};
  for (const [key, state] of Object.entries(value)) {
    if (state === "todo" || state === "sent" || state === "replied") output[key] = state;
  }
  return output;
}

function sanitizedSubmission(
  partyId: string,
  candidate: unknown
): SubmissionRecord | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  const status = record.status;
  if (
    typeof record.partyId !== "string" ||
    record.partyId !== partyId ||
    typeof record.fingerprint !== "string" ||
    typeof record.updatedAt !== "string" ||
    (status !== "opened" &&
      status !== "user_confirmed" &&
      status !== "receipt_confirmed" &&
      status !== "uncertain")
  ) {
    return undefined;
  }
  return {
    partyId,
    fingerprint: record.fingerprint.slice(0, 128),
    status,
    updatedAt: record.updatedAt,
    receipt:
      typeof record.receipt === "string" && record.receipt.trim()
        ? record.receipt.trim().slice(0, 500)
        : undefined,
  };
}

function sanitizeSubmissions(
  value: unknown
): Record<string, SubmissionRecord[]> {
  if (!value || typeof value !== "object") return {};
  const output: Record<string, SubmissionRecord[]> = {};
  for (const [partyId, candidate] of Object.entries(value)) {
    // Migrate the original single-record shape as well as the history shape.
    const candidates = Array.isArray(candidate) ? candidate : [candidate];
    const history = candidates
      .map((entry) => sanitizedSubmission(partyId, entry))
      .filter((entry): entry is SubmissionRecord => Boolean(entry))
      .filter(
        (entry, index, all) =>
          all.findIndex(
            (candidateEntry) =>
              candidateEntry.fingerprint === entry.fingerprint
          ) === index
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20);
    if (history.length) output[partyId] = history;
  }
  return output;
}

export function saveCase(lostCase: LostCase): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...lostCase, updatedAt: new Date().toISOString() })
    );
  } catch {
    // ignore quota / privacy-mode failures
  }
}

export function clearCase(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

const emptyContact = (): Contact => ({
  name: "",
  email: "",
  phone: "",
  postalAddress: "",
});

/** Load the remembered contact so returning travellers never retype it. */
export function loadContact(): Contact {
  if (typeof window === "undefined") return emptyContact();
  try {
    const raw = window.localStorage.getItem(CONTACT_KEY);
    if (!raw) return emptyContact();
    const parsed = JSON.parse(raw) as Partial<Contact>;
    return { ...emptyContact(), ...parsed };
  } catch {
    return emptyContact();
  }
}

export function saveContact(contact: Contact): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONTACT_KEY, JSON.stringify(contact));
  } catch {
    // ignore
  }
}

/** True when the contact carries at least one usable channel. */
export function hasContact(contact: Contact): boolean {
  return Boolean(contact.email.trim() || contact.phone?.trim());
}
