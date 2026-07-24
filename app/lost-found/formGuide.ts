import type {
  ChannelField,
  SemanticField,
} from "../../lib/lost-found-channel-schema";
import { ITEM_CATEGORY_META, type LostCase } from "./types";
import type { ResolvedParty } from "./parties";
import { buildReportDrafts, reportBodyForParty } from "./report";

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
      return reportBodyForParty(buildReportDrafts(lostCase, resolved), resolved);
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

function normalizedOptionText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function venueOption(
  field: ChannelField,
  venues: string[]
): NonNullable<ChannelField["options"]>[number] | undefined {
  if (!field.options?.length) return undefined;
  const selected = new Set<string>();
  for (const venue of venues) {
    const normalizedVenue = normalizedOptionText(venue);
    const exact = field.options.filter(
      (option) => normalizedOptionText(option.label) === normalizedVenue
    );
    if (exact.length === 1) {
      selected.add(exact[0].value);
      continue;
    }
    const partialMatches = field.options
      .map((option) => {
        const normalizedLabel = normalizedOptionText(option.label);
        const contained =
          normalizedLabel.length >= 5 &&
          (normalizedVenue.includes(normalizedLabel) ||
            normalizedLabel.includes(normalizedVenue));
        return {
          option,
          score: contained
            ? Math.min(normalizedVenue.length, normalizedLabel.length) /
              Math.max(normalizedVenue.length, normalizedLabel.length)
            : 0,
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
    const partial = partialMatches.filter((entry) => entry.score >= 0.4);
    if (
      partial.length > 0 &&
      !(normalizedVenue.length < 10 && partialMatches.length > 1) &&
      (partial.length === 1 ||
        partial[0].score - partial[1].score >= 0.1)
    ) {
      selected.add(partial[0].option.value);
    }
  }
  return selected.size === 1
    ? field.options.find((option) => selected.has(option.value))
    : undefined;
}

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
      const matchedOption =
        categoryOption ??
        (field.semanticKey === "venue"
          ? venueOption(field, resolved.venues)
          : field.control === "select"
            ? field.options?.find(
                (option) =>
                  normalizedOptionText(option.label) ===
                  normalizedOptionText(suggestedValue)
              )
            : undefined);
      const needsSelectChoice =
        field.control === "select" && Boolean(suggestedValue) && !matchedOption;
      return {
        field,
        suggestedValue: matchedOption?.label || suggestedValue || undefined,
        autofillValue:
          matchedOption?.value ||
          (field.control === "select" ? undefined : suggestedValue || undefined),
        needsUserInput:
          field.required && (needsSelectChoice || !suggestedValue),
        note:
          needsSelectChoice
            ? "Choose the matching option on the official website."
            : field.semanticKey === "other"
            ? "This site-specific field must be completed on the official website."
            : undefined,
      };
    });
}
