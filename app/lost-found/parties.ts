import type {
  TransitMode,
  TransitOperator,
} from "../berlin-transit/transit";
import type {
  ItemCategory,
  ItineraryEntry,
  ItineraryJourney,
} from "./types";
import { berlinTimeLabel } from "./time";
import type {
  ChannelField,
  PublishedLostFoundChannel,
} from "../../lib/lost-found-channel-schema";
import { isChannelReviewCurrent } from "../../lib/lost-found-channel-schema";

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

export interface PartyAlternativeChannel {
  id: string;
  label: string;
  url: string;
  kind: PublishedLostFoundChannel["kind"];
  submissionMode: PublishedLostFoundChannel["submissionMode"];
  verifiedAt: string;
  reviewCurrent: boolean;
}

/** A lost-property office or official next-step service. */
export interface Party {
  id: string;
  /** Registry channel id; unlike the UI party id, this must match a reviewed adapter exactly. */
  channelId?: string;
  /** The reviewed primary channel controls which contact action is shown. */
  channelKind?: PublishedLostFoundChannel["kind"];
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
  /**
   * Other reviewed ways to reach the same venue. They are backups, not extra
   * reports to send in parallel.
   */
  alternativeChannels?: PartyAlternativeChannel[];
  /** Guidance entries (police/embassy) do not receive a generic lost-property draft. */
  guidanceOnly?: boolean;
  verified: boolean;
  lastVerifiedAt: string;
  /** Official evidence for every public contact/operational field above. */
  fieldSources: Partial<Record<PartySourceField, string>>;
  note?: string;
  formFields?: ChannelField[];
  submissionMode?: PublishedLostFoundChannel["submissionMode"];
  captcha?: boolean;
  loginRequired?: boolean;
  adapterId?: string;
  formContentHash?: string;
  /** Languages supported by the reviewed destination form. */
  languages?: string[];
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
const ODEG_SOURCE = "https://www.odeg.de/kontakt/kontaktformulare/fundsachen";
const NEB_SOURCE = "https://www.neb.de/service/fundbuero/";
const NEB_CONTACT = "https://www.neb.de/kontakt/";
const VBB_DATA_SOURCE = "https://unternehmen.vbb.de/digitale-services/datensaetze/";

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
  odeg: {
    id: "odeg",
    name: "ODEG Lost Property",
    operatorName: "Ostdeutsche Eisenbahn GmbH (ODEG)",
    scope: "ODEG regional trains serving Berlin and Brandenburg",
    website: ODEG_SOURCE,
    formUrl: ODEG_SOURCE,
    formLabel: "Open ODEG loss report",
    phone: "+49 30 514 88 88 88",
    address: "Möllendorffstraße 49 (2nd floor), 10367 Berlin",
    nextStep:
      "Send the ODEG lost-property form with the train, boarding/alighting stops and time. ODEG’s Berlin service centre also handles collection.",
    followUpAfterDays: 3,
    verified: true,
    lastVerifiedAt: VERIFIED_AT,
    fieldSources: {
      scope: ODEG_SOURCE,
      website: ODEG_SOURCE,
      formUrl: ODEG_SOURCE,
      phone: ODEG_SOURCE,
      address: ODEG_SOURCE,
      nextStep: ODEG_SOURCE,
    },
  },
  neb: {
    id: "neb",
    name: "NEB Lost Property",
    operatorName: "Niederbarnimer Eisenbahn (NEB)",
    scope: "NEB regional trains serving Berlin and Brandenburg",
    website: NEB_SOURCE,
    email: "info@NEB.de",
    phone: "+49 30 396011-344",
    address: "Weitlingstraße 15, 10317 Berlin",
    hours: "Mon–Fri 06:15–19:00",
    nextStep:
      "Contact NEB’s lost-property office with the line, boarding/alighting stops and time. The Berlin-Lichtenberg customer centre can help in person.",
    followUpAfterDays: 3,
    verified: true,
    lastVerifiedAt: VERIFIED_AT,
    fieldSources: {
      scope: NEB_SOURCE,
      website: NEB_SOURCE,
      email: NEB_SOURCE,
      phone: NEB_SOURCE,
      address: NEB_CONTACT,
      hours: NEB_CONTACT,
      nextStep: NEB_SOURCE,
    },
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
      "Contact each venue directly using its official website or reception desk. Add Berlin’s central lost-property office separately only for streets, taxis or a genuinely uncertain location.",
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

const OPERATOR_ALIASES: Array<{ partyId: string; patterns: RegExp[] }> = [
  {
    partyId: "bvg",
    patterns: [/berlinerverkehrsbetriebe/, /^bvg(?:aor)?$/],
  },
  {
    partyId: "sbahn",
    patterns: [/sbahnberlin/],
  },
  {
    partyId: "odeg",
    patterns: [/ostdeutscheeisenbahn/, /^odeg/],
  },
  {
    partyId: "neb",
    patterns: [/niederbarnimereisenbahn/, /nebbetriebsgesellschaft/, /^neb$/],
  },
  {
    partyId: "db",
    patterns: [/deutschebahn/, /^dbregioag$/, /^dbfernverkehr/],
  },
];

function normalizedOperator(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Match an exact VBB/GTFS operator identity to its verified contact record. */
export function partyIdForOperator(operator: TransitOperator): string | null {
  const candidates = [operator.id, operator.name].map(normalizedOperator);
  return (
    OPERATOR_ALIASES.find(({ patterns }) =>
      candidates.some((candidate) => patterns.some((pattern) => pattern.test(candidate)))
    )?.partyId ?? null
  );
}

export interface ResolvedParty {
  party: Party;
  reasons: string[];
  lines: string[];
  venues: string[];
  entries: ItineraryEntry[];
}

function channelLabel(channel: PublishedLostFoundChannel): string {
  switch (channel.kind) {
    case "dedicated_lost_found_form":
      return "Dedicated lost-property form";
    case "operator_lost_found_form":
      return "Operator lost-property form";
    case "general_contact_form":
      return "General contact form";
    case "email":
      return "Official email";
    case "phone":
      return "Official phone contact";
    case "central_office_fallback":
      return "Central-office fallback";
  }
}

function channelHref(channel: PublishedLostFoundChannel): string {
  if (channel.kind === "email" && channel.contactValue) {
    return `mailto:${channel.contactValue}`;
  }
  if (channel.kind === "phone" && channel.contactValue) {
    return `tel:${channel.contactValue.replace(/\s+/g, "")}`;
  }
  return channel.pageUrl;
}

function venueParty(entry: ItineraryEntry): Party | null {
  const [channel, ...alternativeChannels] = entry.lostFoundChannels ?? [];
  const channelReviewCurrent = channel
    ? isChannelReviewCurrent(channel)
    : false;
  const website = channel?.pageUrl ?? entry.officialWebsite;
  if (!website) return null;
  const source = channel?.evidence[0]?.sourceUrl ?? entry.contactSourceUrl ?? website;
  const websiteSource = entry.officialWebsiteSourceUrl ?? source;
  const channelHasForm =
    channel?.kind === "dedicated_lost_found_form" ||
    channel?.kind === "operator_lost_found_form" ||
    channel?.kind === "general_contact_form";
  const channelEmail =
    channel?.kind === "email" ? channel.contactValue : undefined;
  const channelPhone =
    channel?.kind === "phone" ? channel.contactValue : undefined;
  const partyEmail = channel ? channelEmail : entry.officialEmail;
  const partyPhone = channel ? channelPhone : entry.officialPhone;
  const manualFormSteps = [
    channel?.fields.some((field) => field.semanticKey === "privacyConsent")
      ? "consent"
      : null,
    channel?.captcha ? "the CAPTCHA or security check" : null,
  ].filter((step): step is string => Boolean(step));
  const formFinish = manualFormSteps.length
    ? `Complete ${manualFormSteps.join(
        " and "
      )} yourself, then submit the form.`
    : "Submit the form yourself.";
  const formLabel = channelHasForm
    ? channel?.submissionMode === "assisted_fill"
      ? "Open verified form with filling guide"
      : "Open verified lost-property page"
    : channel
      ? "Open reviewed official source"
      : entry.lostFoundUrl
        ? "Open the venue’s lost-property page"
        : "Open the public official-site candidate";
  return {
    id: channel ? `channel:${channel.id}` : `venue:${entry.refId}`,
    channelId: channel?.id,
    channelKind: channel?.kind,
    name: channel
      ? `${entry.label} lost-property service`
      : `${entry.label} contact candidate`,
    operatorName: entry.label,
    scope: `Items possibly lost at ${entry.label}`,
    website,
    formUrl: channel
      ? channelHasForm
        ? channel.pageUrl
        : undefined
      : entry.lostFoundUrl,
    formLabel,
    email: partyEmail,
    phone: partyPhone,
    nextStep: channel
      ? channel.kind === "email"
        ? "Send one report to the reviewed official email address. Keep the sent message or any case number as your receipt."
        : channel.kind === "phone"
          ? "Call the reviewed official number and note any case number. Use a written backup only if the office asks you to."
          : `Review the suggested field values below, then open the verified official page. ${formFinish}`
      : entry.lostFoundUrl
      ? "Use the venue’s lost-property page first and include the visit time and a precise item description."
      : "Open the official website and contact reception or visitor service. This contact was found from public venue data and should be checked before sending personal details.",
    followUpAfterDays: 2,
    alternativeChannels: alternativeChannels
      .filter((alternative) => isChannelReviewCurrent(alternative))
      .map((alternative) => ({
        id: alternative.id,
        label: channelLabel(alternative),
        url: channelHref(alternative),
        kind: alternative.kind,
        submissionMode: alternative.submissionMode,
        verifiedAt: alternative.verifiedAt,
        reviewCurrent: true,
      })),
    verified: Boolean(channel) && channelReviewCurrent,
    lastVerifiedAt: channel?.verifiedAt ?? entry.contactUpdatedAt ?? VERIFIED_AT,
    fieldSources: {
      scope: source,
      website: channel ? source : websiteSource,
      formUrl: channel || entry.lostFoundUrl ? source : undefined,
      email: partyEmail ? source : undefined,
      phone: partyPhone ? source : undefined,
      nextStep: source,
    },
    note:
      channel && !channelReviewCurrent
        ? "This channel is past its human re-review date. Check the official page before sharing personal details; assisted filling and submission are disabled."
        : undefined,
    formFields: channelReviewCurrent ? channel?.fields : undefined,
    submissionMode: channelReviewCurrent ? channel?.submissionMode : "open_only",
    captcha: channel?.captcha,
    loginRequired: channel?.loginRequired,
    adapterId: channelReviewCurrent ? channel?.adapterId : undefined,
    formContentHash: channelReviewCurrent ? channel?.contentHash : undefined,
    languages: channel?.language,
  };
}

function uncuratedOperatorParty(operator: TransitOperator, entry: ItineraryEntry): Party | null {
  if (!operator.website) return null;
  return {
    id: `operator:${operator.id}`,
    name: `${operator.name} service`,
    operatorName: operator.name,
    scope: `${entry.label} service operated by ${operator.name}`,
    website: operator.website,
    phone: operator.phone || undefined,
    formLabel: "Open the operator’s official website",
    nextStep:
      "Open the operator’s official website and look for Fundbüro, Fundsachen or contact service. VBB identifies the company, but this homepage has not yet been curated as a dedicated lost-property form.",
    followUpAfterDays: 3,
    verified: false,
    lastVerifiedAt: VERIFIED_AT,
    fieldSources: {
      scope: VBB_DATA_SOURCE,
      website: VBB_DATA_SOURCE,
      phone: operator.phone ? VBB_DATA_SOURCE : undefined,
      nextStep: VBB_DATA_SOURCE,
    },
  };
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
  category: ItemCategory | null = null,
  includeCentralOffice = false
): ResolvedParty[] {
  const order: string[] = [];
  const map = new Map<string, ResolvedParty>();

  const ensureParty = (party: Party): ResolvedParty => {
    let resolved = map.get(party.id);
    if (!resolved) {
      resolved = { party, reasons: [], lines: [], venues: [], entries: [] };
      map.set(party.id, resolved);
      order.push(party.id);
    } else if (party.alternativeChannels?.length) {
      const alternatives = [
        ...(resolved.party.alternativeChannels ?? []),
        ...party.alternativeChannels,
      ];
      resolved.party.alternativeChannels = alternatives.filter(
        (candidate, index) =>
          alternatives.findIndex((entry) => entry.id === candidate.id) === index
      );
    }
    return resolved;
  };
  const ensure = (id: string): ResolvedParty => ensureParty(PARTIES[id]);

  if (category === "documents") {
    const documents = ensure("documents");
    documents.reasons.push("Your item includes a passport, ID card or other identity document");
  }

  for (const entry of itinerary) {
    if (entry.kind === "line" && entry.mode) {
      const partyTargets = new Map<string, Party>();
      for (const operator of entry.operators ?? []) {
        const partyId = partyIdForOperator(operator);
        if (partyId) partyTargets.set(partyId, PARTIES[partyId]);
        else {
          const dynamic = uncuratedOperatorParty(operator, entry);
          if (dynamic) partyTargets.set(dynamic.id, dynamic);
        }
      }
      if (!entry.operators?.length) {
        const fallbackId = partyIdForMode(entry.mode);
        partyTargets.set(fallbackId, PARTIES[fallbackId]);
      }
      for (const [partyId, party] of partyTargets) {
        const resolved = ensureParty(party);
        resolved.entries.push(entry);
        if (!resolved.lines.includes(entry.label)) resolved.lines.push(entry.label);
        const operatorNames = (entry.operators ?? [])
          .filter(
            (operator) =>
              partyIdForOperator(operator) === partyId ||
              `operator:${operator.id}` === partyId
          )
          .map((operator) => operator.name);
        if (operatorNames.length) {
          resolved.reasons.push(`VBB identifies ${operatorNames.join(", ")} as the operator`);
        }
        if (entry.journeys?.length) {
          for (const journey of entry.journeys) {
            resolved.reasons.push(journeyReason(entry.label, journey));
          }
        } else {
          const detail =
            entry.sublabel && entry.sublabel !== entry.label ? ` (${entry.sublabel})` : "";
          resolved.reasons.push(`You rode ${entry.label}${detail}`);
        }
      }
    } else if (entry.kind === "venue") {
      const directParty = venueParty(entry);
      const resolved = directParty ? ensureParty(directParty) : ensure("venues");
      resolved.entries.push(entry);
      if (!resolved.venues.includes(entry.label)) resolved.venues.push(entry.label);
      resolved.reasons.push(`You visited ${entry.label}`);
    }
  }

  if (includeCentralOffice && !map.has("zentral")) {
    const central = ensure("zentral");
    central.reasons.push(
      "You indicated the item may have been lost on a street, in a taxi or outside the listed operators and venues"
    );
  }

  return order.map((id) => map.get(id)!);
}
