import type {
  ChannelField,
  SemanticField,
} from "../../lib/lost-found-channel-schema";
import { ITEM_CATEGORY_META, type LostCase } from "./types";
import type { ResolvedParty } from "./parties";
import { buildReportDrafts } from "./report";

export interface FormGuideEntry {
  field: ChannelField;
  suggestedValue?: string;
  autofillValue?: string;
  needsUserInput: boolean;
  note?: string;
}

function names(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] ?? "", lastName: "" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.at(-1) ?? "",
  };
}

function firstJourneyValue(
  resolved: ResolvedParty,
  key: "from" | "to" | "direction"
): string {
  for (const entry of resolved.entries) {
    for (const journey of entry.journeys ?? []) {
      if (journey[key]) return journey[key] as string;
    }
  }
  return "";
}

function valueFor(
  key: SemanticField,
  lostCase: LostCase,
  resolved: ResolvedParty
): string {
  const { item, contact } = lostCase;
  const splitName = names(contact.name);
  switch (key) {
    case "lossDate":
      return item.lostDate;
    case "lossTime":
      return [item.timeFrom, item.timeTo].filter(Boolean).join("–");
    case "lossLocation":
    case "venue":
      return resolved.venues.join(", ");
    case "lossLocationType":
      return "";
    case "lossCityOrPostalCode":
      return item.lossCity?.trim() ?? "";
    case "transitLine":
      return resolved.lines.join(", ");
    case "boardingStop":
      return firstJourneyValue(resolved, "from");
    case "alightingStop":
      return firstJourneyValue(resolved, "to");
    case "direction":
      return firstJourneyValue(resolved, "direction");
    case "itemCategory":
      return item.category ? ITEM_CATEGORY_META[item.category].label : "";
    case "itemDescription":
      return item.description.trim();
    case "messageBody":
      return buildReportDrafts(lostCase, resolved).de;
    case "brand":
      return item.brand?.trim() ?? "";
    case "color":
      return item.color?.trim() ?? "";
    case "identifyingFeatures":
      return item.identifyingFeatures?.trim() || item.description.trim();
    case "estimatedValue":
      return item.estimatedValue?.trim() ?? "";
    case "fullName":
      return contact.name.trim();
    case "firstName":
      return splitName.firstName;
    case "lastName":
      return splitName.lastName;
    case "email":
      return contact.email.trim();
    case "phone":
      return contact.phone?.trim() ?? "";
    case "postalAddress":
      return contact.postalAddress?.trim() ?? "";
    default:
      return "";
  }
}

const CATEGORY_OPTION_PATTERNS: Record<
  NonNullable<LostCase["item"]["category"]>,
  RegExp
> = {
  bag: /\b(tasche|gepäck|rucksack|bag|luggage|backpack)\b/i,
  wallet: /\b(geldbörse|portemonnaie|wallet|purse)\b/i,
  phone: /\b(mobiltelefon|handy|smartphone|phone)\b/i,
  electronics: /\b(elektronik|computer|laptop|tablet|electronic)\b/i,
  documents: /\b(dokument|ausweis|pass|document|identity)\b/i,
  keys: /\b(schlüssel|key)\b/i,
  camera: /\b(kamera|camera)\b/i,
  clothing: /\b(kleidung|bekleidung|clothing|garment)\b/i,
  other: /\b(sonstig|other)\b/i,
};

export function buildFormGuide(
  lostCase: LostCase,
  resolved: ResolvedParty
): FormGuideEntry[] {
  return (resolved.party.formFields ?? [])
    .filter((field) => field.control !== "hidden")
    .map((field) => {
      if (field.semanticKey === "privacyConsent") {
        return {
          field,
          needsUserInput: true,
          note: "Review and confirm this consent on the official website.",
        };
      }
      if (field.semanticKey === "attachment") {
        return {
          field,
          needsUserInput: true,
          note: "Choose any attachment yourself; files never leave this app automatically.",
        };
      }
      const suggestedValue = valueFor(field.semanticKey, lostCase, resolved);
      const categoryOption =
        field.semanticKey === "itemCategory" && lostCase.item.category
          ? field.options?.find((option) =>
              CATEGORY_OPTION_PATTERNS[lostCase.item.category as NonNullable<
                LostCase["item"]["category"]
              >].test(option.label)
            )
          : undefined;
      return {
        field,
        suggestedValue: categoryOption?.label || suggestedValue || undefined,
        autofillValue: categoryOption?.value || suggestedValue || undefined,
        needsUserInput: field.required && !categoryOption && !suggestedValue,
        note:
          field.semanticKey === "other"
            ? "This site-specific field must be completed on the official website."
            : undefined,
      };
    });
}
