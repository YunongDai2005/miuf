import type { TransitMode } from "../berlin-transit/transit";
import type {
  ItemCategory,
  ItineraryEntry,
  ItineraryJourney,
} from "./types";
import { berlinTimeLabel } from "./time";

export type PartySourceField =
  | "scope"
  | "website"
  | "formUrl"
  | "email"
  | "phone"
  | "address"
  | "hours"
  | "retention"
  | "nextStep"
  | "note";

export interface PartyLink {
  label: string;
  url: string;
}

/** A lost-property office or official next-step service. */
export interface Party {
  id: string;
  name: string;
  operatorName: string;
  scope: string;
  website: string;
  formUrl?: string;
  formLabel?: string;
  email?: string;
  phone?: string;
  address?: string;
  hours?: string;
  retention?: string;
  nextStep?: string;
  followUpAfterDays?: number;
  relatedLinks?: PartyLink[];
  /** Guidance entries (police/embassy) do not receive a generic lost-property draft. */
  guidanceOnly?: boolean;
  verified: boolean;
  lastVerifiedAt: string;
  /** Official evidence for every public contact/operational field above. */
  fieldSources: Partial<Record<PartySourceField, string>>;
  note?: string;
}

const VERIFIED_AT = "2026-07-23";
const BVG_SOURCE = "https://www.bvg.de/en/service-and-support/lost-and-found";
const BVG_PHONE_SOURCE = "https://www.bvg.de/en/company/about-us/compliance";
const SBAHN_SOURCE =
  "https://sbahn.berlin/en/plan-a-journey/practical-help-on-the-way/lost-found-service/";
const DB_SOURCE = "https://www.bahn.de/service/ueber-uns/fundservice";
const DB_FORM = "https://www.bahn.de/service/ueber-uns/fundservice/verlustmeldung";
const CENTRAL_SOURCE =
  "https://www.berlin.de/ba-tempelhof-schoeneberg/politik-und-verwaltung/aemter/amt-fuer-buergerdienste/fundbuero/";
const CENTRAL_CONTACT = "https://service.berlin.de/standort/324098/";
const CENTRAL_FORM = "https://fundinfo.novafind.eu/home/fundinfo/f11000000/app/";
const DOCUMENTS_SOURCE =
  "https://www.berlin.de/en/tourism/travel-information/1735948-2862820-lost-and-found-and-lost-property-offices.en.html";
const POLICE_ONLINE = "https://www.internetwache-polizei-berlin.de/";
const EMBASSIES =
  "https://www.berlin.de/en/tourism/travel-information/2917712-2862820-embassies-in-berlin.en.html";

export const PARTIES: Record<string, Party> = {
  documents: {
    id: "documents",
    name: "Police report & passport replacement",
    operatorName: "Berlin Police + your country’s embassy",
    scope: "Passports, national ID cards and other important identity documents",
    website: DOCUMENTS_SOURCE,
    formUrl: POLICE_ONLINE,
    formLabel: "Open Berlin Police online station",
    relatedLinks: [{ label: "Find your embassy in Berlin", url: EMBASSIES }],
    guidanceOnly: true,
    nextStep:
      "Report the missing passport or ID to the police immediately, then contact your country’s embassy or consulate for replacement travel documents. Also report it to the relevant lost-property office below.",
    verified: true,
    lastVerifiedAt: VERIFIED_AT,
    fieldSources: {
      scope: DOCUMENTS_SOURCE,
      website: DOCUMENTS_SOURCE,
      formUrl: "https://www.berlin.de/polizei/allgemeine-seiten/artikel.103548.en.php",
      nextStep: DOCUMENTS_SOURCE,
      note: DOCUMENTS_SOURCE,
    },
    note: "If the document was stolen, tell the police it was theft rather than simple loss.",
  },
  bvg: {
    id: "bvg",
    name: "BVG Lost Property (Fundbüro)",
    operatorName: "Berliner Verkehrsbetriebe (BVG)",
    scope: "U-Bahn · Tram · Bus · Ferry",
    website: BVG_SOURCE,
    formUrl: BVG_SOURCE,
    formLabel: "Open BVG loss report",
    phone: "+49 30 19449",
    address: "Rudolfstraße 1–8, 10245 Berlin",
    hours: "Mon, Tue, Thu, Fri 09:00–17:00 · Wed/weekends closed",
    retention: "BVG keeps found items for up to 6 weeks.",
    nextStep:
      "Submit the online loss report now. BVG emails you when a possible match appears; unclaimed items may be destroyed or auctioned after 6 weeks.",
    followUpAfterDays: 3,
    verified: true,
    lastVerifiedAt: VERIFIED_AT,
    fieldSources: {
      scope: BVG_SOURCE,
      website: BVG_SOURCE,
      formUrl: BVG_SOURCE,
      phone: BVG_PHONE_SOURCE,
      address: BVG_SOURCE,
      hours: BVG_SOURCE,
      retention: BVG_SOURCE,
      nextStep: BVG_SOURCE,
    },
  },
  sbahn: {
    id: "sbahn",
    name: "S-Bahn Berlin Lost Property",
    operatorName: "S-Bahn Berlin GmbH",
    scope: "S-Bahn trains and S-Bahn platforms",
    website: SBAHN_SOURCE,
    formUrl:
      "https://sbahn.berlin/en/plan-a-journey/practical-help-on-the-way/lost-found-service/lost-property-service/",
    formLabel: "Open S-Bahn loss report",
    phone: "+49 30 297 43 333",
    address: "Rudolfstraße 1–8, 10245 Berlin",
    hours: "Mon, Tue, Thu, Fri 09:00–17:00 · Wed/weekends/holidays closed",
    retention: "S-Bahn keeps eligible found items for 10 weeks.",
    nextStep:
      "Submit the online report (accepted for losses up to 4 weeks ago). If matched, bring the fund number and valid ID to collect the item.",
    followUpAfterDays: 3,
    verified: true,
    lastVerifiedAt: VERIFIED_AT,
    fieldSources: {
      scope: SBAHN_SOURCE,
      website: SBAHN_SOURCE,
      formUrl: SBAHN_SOURCE,
      phone: SBAHN_SOURCE,
      address: SBAHN_SOURCE,
      hours: SBAHN_SOURCE,
      retention: SBAHN_SOURCE,
      nextStep: SBAHN_SOURCE,
    },
  },
  db: {
    id: "db",
    name: "DB Fundservice",
    operatorName: "Deutsche Bahn",
    scope: "Regional trains (RB / RE / FEX), long-distance trains and mixed-service stations",
    website: DB_SOURCE,
    formUrl: DB_FORM,
    formLabel: "Open DB loss report",
    retention:
      "Items are normally stored at the station for 7 days, then transferred to DB’s central lost-property office.",
    nextStep:
      "Submit one online report as soon as possible. DB’s online platform covers items worth over €15 and items with personal value; ask the station directly about lower-value items.",
    followUpAfterDays: 7,
    verified: true,
    lastVerifiedAt: VERIFIED_AT,
    fieldSources: {
      scope: DB_SOURCE,
      website: DB_SOURCE,
      formUrl: DB_FORM,
      retention: DB_SOURCE,
      nextStep: DB_SOURCE,
      note: DB_SOURCE,
    },
    note: "DB may charge a handling fee when an item is returned.",
  },
  zentral: {
    id: "zentral",
    name: "Berlin Central Lost Property (Zentrales Fundbüro)",
    operatorName: "Land Berlin",
    scope: "City-wide catch-all for streets, taxis, public buildings and uncertain locations",
    website: CENTRAL_SOURCE,
    formUrl: CENTRAL_FORM,
    formLabel: "Open Berlin loss report",
    email: "fundbuero@ba-ts.berlin.de",
    phone: "+49 30 90277-3101",
    address: "Platz der Luftbrücke 6, 12101 Berlin",
    hours: "Mon/Tue 09:00–14:00 · Thu 13:00–18:00",
    retention:
      "Items from police stations and citizens’ offices take at least 3 working days to arrive.",
    nextStep:
      "Submit the separate central-office report now, but avoid general phone, email or in-person enquiries during the first week after the loss.",
    followUpAfterDays: 7,
    verified: true,
    lastVerifiedAt: VERIFIED_AT,
    fieldSources: {
      scope: CENTRAL_SOURCE,
      website: CENTRAL_SOURCE,
      formUrl: CENTRAL_SOURCE,
      email: CENTRAL_CONTACT,
      phone: CENTRAL_CONTACT,
      address: CENTRAL_CONTACT,
      hours: CENTRAL_CONTACT,
      retention: CENTRAL_SOURCE,
      nextStep: CENTRAL_SOURCE,
      note: CENTRAL_SOURCE,
    },
  },
  venues: {
    id: "venues",
    name: "The venue(s) you visited",
    operatorName: "Each venue’s reception or visitor service",
    scope: "Museums, attractions, restaurants and landmarks",
    website: CENTRAL_SOURCE,
    formLabel: "Open Berlin lost-property guidance",
    retention: "Handling and storage periods differ by venue.",
    nextStep:
      "Contact each venue directly using its official website or reception desk, then also register with Berlin’s central lost-property office if the location is uncertain.",
    followUpAfterDays: 2,
    verified: true,
    lastVerifiedAt: VERIFIED_AT,
    fieldSources: {
      scope: CENTRAL_SOURCE,
      website: CENTRAL_SOURCE,
      retention: CENTRAL_SOURCE,
      nextStep: CENTRAL_SOURCE,
    },
  },
};

export function partyIdForMode(mode: TransitMode): string {
  switch (mode) {
    case "subway":
    case "tram":
    case "bus":
    case "ferry":
      return "bvg";
    case "light_rail":
      return "sbahn";
    case "rail":
      return "db";
    default:
      return "zentral";
  }
}

export interface ResolvedParty {
  party: Party;
  reasons: string[];
  lines: string[];
  venues: string[];
  entries: ItineraryEntry[];
}

function journeyReason(label: string, journey: ItineraryJourney): string {
  const time = journey.departure ? berlinTimeLabel(journey.departure) : null;
  const route =
    journey.from && journey.to
      ? `${journey.from} → ${journey.to}`
      : journey.from
        ? `from ${journey.from}`
        : journey.to
          ? `to ${journey.to}`
          : "";
  const direction = journey.direction ? `direction ${journey.direction}` : "";
  return [`You rode ${label}`, time, route, direction].filter(Boolean).join(" · ");
}

/** Resolve a deduplicated, ordered contact plan for this item and itinerary. */
export function resolveParties(
  itinerary: ItineraryEntry[],
  category: ItemCategory | null = null
): ResolvedParty[] {
  const order: string[] = [];
  const map = new Map<string, ResolvedParty>();

  const ensure = (id: string): ResolvedParty => {
    let resolved = map.get(id);
    if (!resolved) {
      resolved = { party: PARTIES[id], reasons: [], lines: [], venues: [], entries: [] };
      map.set(id, resolved);
      order.push(id);
    }
    return resolved;
  };

  if (category === "documents") {
    const documents = ensure("documents");
    documents.reasons.push("Your item includes a passport, ID card or other identity document");
  }

  let usedTransit = false;
  for (const entry of itinerary) {
    if (entry.kind === "line" && entry.mode) {
      usedTransit = true;
      const resolved = ensure(partyIdForMode(entry.mode));
      resolved.entries.push(entry);
      if (!resolved.lines.includes(entry.label)) resolved.lines.push(entry.label);
      if (entry.journeys?.length) {
        for (const journey of entry.journeys) {
          resolved.reasons.push(journeyReason(entry.label, journey));
        }
      } else {
        const detail =
          entry.sublabel && entry.sublabel !== entry.label ? ` (${entry.sublabel})` : "";
        resolved.reasons.push(`You rode ${entry.label}${detail}`);
      }
    } else if (entry.kind === "venue") {
      const resolved = ensure("venues");
      resolved.entries.push(entry);
      if (!resolved.venues.includes(entry.label)) resolved.venues.push(entry.label);
      resolved.reasons.push(`You visited ${entry.label}`);
    }
  }

  if (usedTransit && !map.has("zentral")) {
    const central = ensure("zentral");
    central.reasons.push(
      "A separate city-wide report is useful when the exact loss location is uncertain"
    );
  }

  return order.map((id) => map.get(id)!);
}
