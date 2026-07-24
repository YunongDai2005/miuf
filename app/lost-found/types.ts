import type {
  TransitMode,
  TransitOperator,
} from "../berlin-transit/transit";
import type { AttractionCategory } from "../berlin-transit/attractions";
import type { PublishedLostFoundChannel } from "../../lib/lost-found-channel-schema";
import { berlinDateKey } from "./time";

/** What kind of thing the traveller lost. Drives the report wording and icon. */
export type ItemCategory =
  | "bag"
  | "wallet"
  | "phone"
  | "electronics"
  | "documents"
  | "keys"
  | "camera"
  | "clothing"
  | "other";

export interface LostItem {
  category: ItemCategory | null; // optional one-tap hint
  description: string; // one-line free text: colour, brand, contents…
  lostDate: string; // yyyy-mm-dd
  timeFrom?: string; // HH:mm
  timeTo?: string; // HH:mm
  brand?: string;
  color?: string;
  identifyingFeatures?: string;
  estimatedValue?: string;
  lossCity?: string;
  /**
   * The Berlin central office is appropriate for streets, taxis and genuinely
   * uncertain locations, but not as a blanket duplicate of every operator or
   * venue report.
   */
  includeCentralOffice?: boolean;
}

export interface Contact {
  name: string;
  email: string;
  phone?: string;
  postalAddress?: string;
}

export type ItineraryKind = "line" | "venue";

export interface ItineraryJourney {
  from?: string;
  to?: string;
  departure?: string;
  direction?: string;
}

/** One place or line the traveller passed through on the lost day. */
export interface ItineraryEntry {
  uid: string;
  kind: ItineraryKind;
  refId: string; // transit line id or attraction id
  label: string; // "U5" / "Museumsinsel"
  sublabel?: string; // line name / category label
  mode?: TransitMode; // set for lines
  category?: AttractionCategory; // set for venues
  /** Board/alight/time details retained from live or offline route inference. */
  journeys?: ItineraryJourney[];
  /** Actual operator(s), when VBB or the official GTFS feed identifies them. */
  operators?: TransitOperator[];
  /** Venue contact candidates resolved offline; the itinerary never leaves the device. */
  officialWebsite?: string;
  officialPhone?: string;
  officialEmail?: string;
  lostFoundUrl?: string;
  contactSourceUrl?: string;
  officialWebsiteSourceUrl?: string;
  contactUpdatedAt?: string;
  /** Refreshed from the reviewed public registry; stale copies are discarded on load. */
  lostFoundChannels?: PublishedLostFoundChannel[];
}

export type ReportState = "todo" | "sent" | "replied";

export type SubmissionStatus =
  | "opened"
  | "user_confirmed"
  | "receipt_confirmed"
  | "uncertain";

export interface SubmissionRecord {
  partyId: string;
  fingerprint: string;
  status: SubmissionStatus;
  updatedAt: string;
  receipt?: string;
}

/** Result copied back from the optional form helper after its final check. */
export interface SubmissionOutcomePackage {
  version: 1;
  channelId: string;
  fingerprint: string;
  status: Exclude<SubmissionStatus, "opened">;
  updatedAt: string;
  receipt?: string;
}

export interface LostCase {
  version: 1;
  item: LostItem;
  contact: Contact;
  itinerary: ItineraryEntry[];
  /** partyId -> progress the traveller has logged. */
  reported: Record<string, ReportState>;
  /** Local evidence history by party; exact fingerprints prevent old duplicates too. */
  submissions: Record<string, SubmissionRecord[]>;
  updatedAt: string;
}

export function emptyCase(): LostCase {
  return {
    version: 1,
    item: {
      category: null,
      description: "",
      lostDate: berlinDateKey(),
      timeFrom: "",
      timeTo: "",
      brand: "",
      color: "",
      identifyingFeatures: "",
      estimatedValue: "",
      lossCity: "",
      includeCentralOffice: false,
    },
    contact: { name: "", email: "", phone: "", postalAddress: "" },
    itinerary: [],
    reported: {},
    submissions: {},
    updatedAt: new Date().toISOString(),
  };
}

export const ITEM_CATEGORY_META: Record<ItemCategory, { label: string; emoji: string }> = {
  bag: { label: "Bag / luggage", emoji: "🎒" },
  wallet: { label: "Wallet", emoji: "👛" },
  phone: { label: "Phone", emoji: "📱" },
  electronics: { label: "Electronics", emoji: "💻" },
  documents: { label: "Documents / ID", emoji: "📄" },
  keys: { label: "Keys", emoji: "🔑" },
  camera: { label: "Camera", emoji: "📷" },
  clothing: { label: "Clothing", emoji: "🧥" },
  other: { label: "Other", emoji: "📦" },
};
