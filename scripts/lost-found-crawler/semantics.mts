import type {
  FormControl,
  SemanticField,
} from "../../lib/lost-found-channel-schema";

type SemanticRule = {
  key: SemanticField;
  pattern: RegExp;
  confidence: number;
};

const RULES: SemanticRule[] = [
  {
    key: "lossLocationType",
    pattern: /\b(art des verlustorts|verlustorttyp|type of loss location)\b/i,
    confidence: 0.96,
  },
  {
    key: "lossCityOrPostalCode",
    pattern: /\b(postleitzahl\s*\/\s*ort|plz\s*\/\s*ort|loss (city|postal code))\b/i,
    confidence: 0.94,
  },
  {
    key: "lossDate",
    pattern: /\b(verlustdatum|funddatum|wann.{0,20}verlor|date.{0,20}lost|loss date)\b/i,
    confidence: 0.94,
  },
  {
    key: "lossTime",
    pattern: /\b(verlustzeit|uhrzeit|wann.{0,20}verlor|time.{0,20}lost|loss time)\b/i,
    confidence: 0.92,
  },
  {
    key: "lossLocation",
    pattern: /\b(verlustort|fundort|wo.{0,20}verlor|where.{0,20}lost|loss location)\b/i,
    confidence: 0.94,
  },
  {
    key: "boardingStop",
    pattern: /\b(einstieg|einstiegshaltestelle|boarding stop|boarded at)\b/i,
    confidence: 0.94,
  },
  {
    key: "alightingStop",
    pattern: /\b(ausstieg|ausstiegshaltestelle|alighting stop|left at)\b/i,
    confidence: 0.94,
  },
  {
    key: "transitLine",
    pattern: /\b(linie|liniennummer|zugnummer|line|train number)\b/i,
    confidence: 0.88,
  },
  {
    key: "direction",
    pattern: /\b(fahrtrichtung|richtung|direction|destination)\b/i,
    confidence: 0.86,
  },
  {
    key: "itemCategory",
    pattern: /\b(gegenstandsart|gegenstandskategorie|fundsachengruppe|item category|type of item)\b/i,
    confidence: 0.94,
  },
  {
    key: "brand",
    pattern: /\b(marke|hersteller|fabrikat|brand|manufacturer|make)\b/i,
    confidence: 0.9,
  },
  {
    key: "color",
    pattern: /\b(farbe|colour|color)\b/i,
    confidence: 0.95,
  },
  {
    key: "identifyingFeatures",
    pattern: /\b(besondere merkmale|erkennungsmerkmal|kennzeichen|identifying feature|distinguishing)\b/i,
    confidence: 0.91,
  },
  {
    key: "estimatedValue",
    pattern: /\b(wert|zeitwert|estimated value|approximate value)\b/i,
    confidence: 0.9,
  },
  {
    key: "messageBody",
    pattern:
      /^(nachricht|ihre nachricht|mitteilung|ihre mitteilung(?: an .+)?|anfrage|message|your message|enquiry)$/i,
    confidence: 0.9,
  },
  {
    key: "itemDescription",
    pattern: /\b(beschreibung|gegenstand.{0,12}beschreiben|description|describe.{0,12}item|details)\b/i,
    confidence: 0.86,
  },
  {
    key: "firstName",
    pattern: /\b(vorname|first ?name|given name)\b/i,
    confidence: 0.97,
  },
  {
    key: "lastName",
    pattern: /\b(nachname|familienname|last name|surname|family name)\b/i,
    confidence: 0.97,
  },
  {
    key: "fullName",
    pattern: /^(name|ihr name|your name|vollständiger name|full name)$/i,
    confidence: 0.88,
  },
  {
    key: "email",
    pattern: /\b(e-?mail|mailadresse|email address)\b/i,
    confidence: 0.98,
  },
  {
    key: "phone",
    pattern: /\b(telefon|telefonnummer|mobilnummer|phone|telephone|mobile)\b/i,
    confidence: 0.97,
  },
  {
    key: "postalAddress",
    pattern: /\b(anschrift|adresse|straße|strasse|postleitzahl|plz|postal address|street|postcode|zip)\b/i,
    confidence: 0.83,
  },
  {
    key: "venue",
    pattern: /\b(museum|einrichtung|standort|filiale|venue|location|facility)\b/i,
    confidence: 0.72,
  },
  {
    key: "privacyConsent",
    pattern:
      /\b(datenschutz(?:erklärung)?|einwilligung|privacy|consent|dsgvo|gdpr|agb|terms(?: and conditions)?|speicherung (?:ihrer|personenbezogener) daten|storage of personal data|agree.{0,40}data provided)\b/i,
    confidence: 0.96,
  },
];

export function inferSemanticField(input: {
  control: FormControl;
  label: string;
  helpText?: string;
  placeholder?: string;
  rawName?: string;
}): { key: SemanticField; confidence: number } {
  if (input.control === "email") return { key: "email", confidence: 0.99 };
  if (input.control === "tel") return { key: "phone", confidence: 0.99 };
  if (input.control === "file") return { key: "attachment", confidence: 0.99 };
  const pieces = [
    input.label,
    input.helpText,
    input.placeholder,
    input.rawName,
  ]
    .filter(Boolean)
    .map((value) =>
      String(value)
        .replace(/\s+/g, " ")
        .replace(/\s*\*+\s*$/, "")
        .trim()
    );
  const text = pieces
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  for (const rule of RULES) {
    if (
      rule.pattern.test(text) ||
      pieces.some((piece) => rule.pattern.test(piece))
    ) {
      return { key: rule.key, confidence: rule.confidence };
    }
  }
  return { key: "other", confidence: 0.2 };
}
