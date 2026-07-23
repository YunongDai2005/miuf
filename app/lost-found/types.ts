import type {
  TransitMode,
  TransitOperator,
} from "../berlin-transit/transit";
import type { AttractionCategory } from "../berlin-transit/attractions";
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
}

export interface Contact {
  name: string;
  email: string;
  phone?: string;
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
}

export type ReportState = "todo" | "sent" | "replied";

export interface LostCase {
  version: 1;
  item: LostItem;
  contact: Contact;
  itinerary: ItineraryEntry[];
  /** partyId -> progress the traveller has logged. */
  reported: Record<string, ReportState>;
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
    },
    contact: { name: "", email: "", phone: "" },
    itinerary: [],
    reported: {},
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
