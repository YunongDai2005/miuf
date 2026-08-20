import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import robotsParser from "robots-parser";
import { extractRenderedForms } from "./browser.mjs";
import { extractFormsFromHtml } from "./form-extractor.mjs";
import { stableHash, stableId } from "./hash.mjs";
import {
  pageEvidenceFromHtml,
  pageEvidenceHash,
} from "./page-evidence.mjs";
import { extractPdfText } from "./pdf-text.mjs";
import {
  safeFetchBytes,
  safeFetchText,
  type SafeFetchBytesResult,
  type SafeFetchResult,
} from "./safe-fetch.mjs";
import { scoreCandidate } from "./scoring.mjs";
import type {
  CandidateFile,
  ChannelCandidate,
  DiscoveryPathStep,
  InventoryFile,
} from "./schemas";

const ROBOT_NAME = "Berlin-Lost-Found-Channel-Research";
export const DISCOVERY_POLICY_VERSION = 2;
const LOST_PATTERN =
  /fundbüro|fundbuero|fundsache|verlust|verloren|lost[- ]?found|lost property/i;
const PAGE_LOST_PATTERN =
  /fundbüro|fundbuero|fundsache|verlustmeldung|gegenstand.{0,30}verloren|verloren.{0,30}gegenstand|etwas.{0,20}verloren|verloren.{0,20}oder.{0,20}gefunden|lost[- ]?found|lost property|lost.{0,20}or.{0,20}found/i;
const CONTACT_PURPOSE_PATTERN =
  /fundbüro|fundbuero|fundsache|verlust|verloren|lost[- ]?found|lost property|fahrrad|handy|schlüssel|gegenstände?|haustier|katze|hund|schildkröte|item|belonging|animal|pet/i;
const CONTACT_PATTERN =
  /kontakt|contact|besucherservice|visitor service|gästeservice|service|hilfe|faq|impressum|imprint|ansprechpartner/i;
const CONTACT_PAGE_PATTERN =
  /kontakt|contact|besucherservice|visitor service|gästeservice|service|hilfe|faq|impressum|imprint|ansprechpartner/i;
const PDF_POLICY_PATTERN =
  /besucherordnung|visitor[-_ ]?(?:information|rules)|rules[-_ ]?for[-_ ]?visitors|hausordnung|house[-_ ]?rules/i;
const IRRELEVANT_GENERAL_CONTACT_PATTERN =
  /buchung|booking|group|gruppe|feedback|survey|umfrage|ticket|presse|press|widerruf|withdrawal|storno|cancel(?:lation)?|refund|seminar|dreharbeit|filming|bestellung|order/i;
const SKIP_PATTERN =
  /\/(news|presse(?:mitteilungen)?|press|karriere|jobs|shop|tickets?|events?|kalender|calendar|datenschutz|privacy|sitemap)(?:\/|$)|\.(?:jpe?g|png|gif|webp|svg|zip|mp[34]|ics)$/i;

type QueueEntry = {
  url: string;
  depth: number;
  path: DiscoveryPathStep[];
  externalLeaf: boolean;
  priority: number;
};

type RobotsPolicy = {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getSitemaps(): string[];
};

export interface DiscoveredPublicContact {
  kind: "email" | "phone";
  value: string;
  selector: string;
  excerpt: string;
}

export interface DiscoverySeedGroup {
  origin: string;
  seeds: string[];
  venueIds: Set<string>;
  operatorIds: Set<string>;
}

export function discoveryScopeId(group: DiscoverySeedGroup): string {
  const ownerScopeKey = [
    ...[...group.operatorIds].map((id) => `operator:${id}`),
    ...[...group.venueIds].sort().map((id) => `venue:${id}`),
  ].join("|");
  return stableId("crawl_scope", {
    policyVersion: DISCOVERY_POLICY_VERSION,
    origin: group.origin,
    ownerScopeKey,
    seeds: [...group.seeds].sort(),
  });
}

export function crawlShardForOrigin(origin: string, shardCount: number): number {
  const count = Math.max(1, Math.floor(shardCount));
  return Number.parseInt(stableHash(origin).slice(0, 8), 16) % count;
}

export function buildDiscoverySeedGroups(
  inventory: InventoryFile,
  domain?: string
): DiscoverySeedGroup[] {
  const groupsByOwner = new Map<string, DiscoverySeedGroup>();
  const entityVenueIds = new Map(
    inventory.entityGroups.map((group) => [group.id, group.venueIds])
  );
  const operatorsById = new Map(
    inventory.operators.map((operator) => [operator.id, operator])
  );
  for (const venue of inventory.venues) {
    const usesAuditedOperator =
      venue.operatorResolutionSource === "official_source_audit" &&
      Boolean(venue.operatorId && venue.operatorWebsite);
    const usesOperatorSeed =
      usesAuditedOperator ||
      (!venue.officialWebsite &&
        Boolean(venue.operatorId && venue.operatorWebsite));
    const seed = usesOperatorSeed
      ? venue.operatorWebsite
      : venue.officialWebsite ?? venue.operatorWebsite;
    if (!seed || venue.resolutionStatus === "parent_venue_required") continue;
    const url = new URL(seed);
    if (
      domain &&
      !url.hostname.toLowerCase().includes(domain.toLowerCase())
    ) {
      continue;
    }
    // A shared host is not evidence of a shared responsible organisation.
    // Only an explicit operator website may merge venues by operator.
    const ownerKey = usesOperatorSeed
      ? `operator:${venue.operatorId}`
      : `entity:${venue.entityGroupId}`;
    const key = `${ownerKey}|${url.origin}`;
    const existing = groupsByOwner.get(key) ?? {
      origin: url.origin,
      seeds: [],
      venueIds: new Set<string>(),
      operatorIds: new Set<string>(),
    };
    const seedCandidates =
      usesAuditedOperator
        ? [
            url.toString(),
            ...(operatorsById.get(venue.operatorId!)?.discoverySeedUrls ?? []),
            ...(venue.officialWebsite ? [venue.officialWebsite] : []),
          ]
        : [url.toString()];
    for (const seedCandidate of seedCandidates) {
      const candidateUrl = new URL(seedCandidate);
      if (usesAuditedOperator && !sameSiteHost(url, candidateUrl)) continue;
      if (!existing.seeds.includes(candidateUrl.toString())) {
        existing.seeds.push(candidateUrl.toString());
      }
    }
    const relatedVenueIds = usesOperatorSeed
      ? [venue.venueId]
      : entityVenueIds.get(venue.entityGroupId) ?? [venue.venueId];
    for (const venueId of relatedVenueIds) existing.venueIds.add(venueId);
    if (usesOperatorSeed && venue.operatorId) {
      existing.operatorIds.add(venue.operatorId);
    }
    groupsByOwner.set(key, existing);
  }
  return [...groupsByOwner.values()].sort(
    (left, right) =>
      left.origin.localeCompare(right.origin) ||
      [...left.venueIds][0].localeCompare([...right.venueIds][0])
  );
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function primaryContentRoot($: cheerio.CheerioAPI) {
  const body = $("body");
  const bodyClone = body.clone();
  bodyClone
    .find("nav, header, footer, aside, script, style, noscript")
    .remove();
  const bodyTextLength = compactText(bodyClone.text()).length;
  const candidates = $("main, article, [role='main']").toArray();
  const [best] = candidates
    .map((node) => {
      const clone = $(node).clone();
      clone.find("nav, header, footer, aside, script, style, noscript").remove();
      return { node, textLength: compactText(clone.text()).length };
    })
    .sort((left, right) => right.textLength - left.textLength);
  return best && best.textLength >= bodyTextLength * 0.25
    ? $(best.node)
    : body;
}

function canonicalUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

/**
 * Reuses one in-flight or completed network load for every canonical URL.
 * Rejections stay cached for the lifetime of the discovery run as well: a
 * shared but unavailable official site must not consume the timeout budget
 * once for every venue that happens to reference it.
 */
export function createCanonicalLoadCache<T extends { url?: string }>() {
  const loads = new Map<string, Promise<T>>();
  return {
    async load(rawUrl: string, loader: () => Promise<T>) {
      const key = candidateUrlIdentity(rawUrl);
      const cached = loads.get(key);
      if (cached) {
        return { value: await cached, cacheHit: true };
      }
      const pending = loader();
      loads.set(key, pending);
      const value = await pending;
      if (value.url) {
        loads.set(candidateUrlIdentity(value.url), pending);
      }
      return { value, cacheHit: false };
    },
    get size() {
      return loads.size;
    },
  };
}

export function candidateUrlIdentity(rawUrl: string): string {
  const url = new URL(canonicalUrl(rawUrl));
  if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

export function formCandidateId(input: {
  ownerScopeKey: string;
  pageUrl: string;
  formIndex: number;
  hasForm: boolean;
}): string {
  return stableId(
    "channel",
    `${input.ownerScopeKey}|${candidateUrlIdentity(input.pageUrl)}|${
      input.hasForm ? `form:${input.formIndex}` : "page"
    }`
  );
}

export function shouldSkipDiscoveryUrl(rawUrl: string): boolean {
  return SKIP_PATTERN.test(new URL(rawUrl).pathname);
}

function linkPriority(url: string, label: string): number {
  const text = `${url} ${label}`;
  if (LOST_PATTERN.test(text)) return 100;
  if (/\.pdf(?:$|[?#])/i.test(url) && PDF_POLICY_PATTERN.test(text)) return 60;
  if (CONTACT_PATTERN.test(text)) return 30;
  return 0;
}

function sameSiteHost(left: URL, right: URL): boolean {
  const normalize = (hostname: string) => hostname.replace(/^www\./, "").toLowerCase();
  return normalize(left.hostname) === normalize(right.hostname);
}

function publicContactValues(
  $: cheerio.CheerioAPI,
  dedicatedPage: boolean,
  allowPageWideAnchors = dedicatedPage,
  // A page whose whole purpose is to publish a contact — /kontakt, /impressum —
  // usually puts the address block in the footer, outside <main>. Only there is
  // the whole document searched; on a lost-property page the main content is
  // still the boundary, so a press address in the footer stays out.
  wholeDocument = false
): DiscoveredPublicContact[] {
  const preferred = wholeDocument ? $() : primaryContentRoot($);
  const root = (preferred.length ? preferred : $("body")).clone();
  root.find("script, style, noscript").remove();
  if (!allowPageWideAnchors && !wholeDocument) {
    root.find("nav, header, footer, aside").remove();
  }
  const contacts: Array<{
    kind: "email" | "phone";
    value: string;
    selector: string;
    excerpt: string;
  }> = [];
  const rootText = compactText(
    root
      .clone()
      .find("nav, header, footer, aside, script, style, noscript")
      .remove()
      .end()
      .text()
  );
  const purposeScore = (excerpt: string): number =>
    Number(/fahrrad|handy|schlüssel|gegenstände?|item|belonging/i.test(excerpt)) *
      2 -
    Number(/haustier|katze|hund|schildkröte|animal|pet/i.test(excerpt));
  const excerptAround = (needle: string, fallback: string): string => {
    const haystack = rootText.toLowerCase();
    const target = needle.toLowerCase();
    const excerpts: string[] = [];
    let searchFrom = 0;
    while (searchFrom < haystack.length) {
      const index = haystack.indexOf(target, searchFrom);
      if (index < 0) break;
      const start = Math.max(0, index - 260);
      const end = Math.min(rootText.length, index + needle.length + 360);
      excerpts.push(rootText.slice(start, end).trim());
      searchFrom = index + Math.max(1, target.length);
    }
    if (!excerpts.length) return compactText(fallback).slice(0, 700);
    return excerpts.sort(
      (left, right) => purposeScore(right) - purposeScore(left)
    )[0];
  };
  const localExcerpt = (anchor: Element, value: string): string => {
    let context = $(anchor);
    let fallback = compactText($(anchor).parent().text());
    for (let level = 0; level < 5; level += 1) {
      context = context.parent();
      if (!context.length || context.is("body")) break;
      const text = compactText(context.text());
      if (text.length >= 20 && text.length <= 900) fallback = text;
      if (CONTACT_PURPOSE_PATTERN.test(text) && text.length <= 900) return text;
      if (context.is("main, article, [role='main']")) break;
    }
    return excerptAround(value, fallback);
  };
  root.find("a[href]").each((_, anchor) => {
    if (!allowPageWideAnchors) {
      let context = $(anchor);
      let locallyRelevant = false;
      for (let level = 0; level < 4; level += 1) {
        context = context.parent();
        if (!context.length || context.is("main, body")) break;
        const contextText = compactText(context.text());
        if (
          contextText.length <= 1_500 &&
          PAGE_LOST_PATTERN.test(contextText)
        ) {
          locallyRelevant = true;
          break;
        }
      }
      if (!locallyRelevant) return;
    }
    const href = ($(anchor).attr("href") ?? "").trim();
    if (/^mailto:/i.test(href)) {
      let value = href.slice("mailto:".length).split("?")[0].trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        // Retain the literal public value if its escaping is malformed.
      }
      if (
        value.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
      ) {
        contacts.push({
          kind: "email",
          value,
          selector: 'a[href^="mailto:"]',
          excerpt: localExcerpt(anchor, value),
        });
      }
    } else if (/^tel:/i.test(href)) {
      let value = href.slice("tel:".length).split("?")[0].trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        // Retain the literal public value if its escaping is malformed.
      }
      if (/[a-z]/i.test(value)) return;
      value = value.replace(/[^\d+() .-]/g, "").trim();
      if (value.replace(/\D/g, "").length >= 6 && value.length <= 40) {
        contacts.push({
          kind: "phone",
          value,
          selector: 'a[href^="tel:"]',
          excerpt: localExcerpt(anchor, value),
        });
      }
    }
  });

  if (dedicatedPage) {
    const obfuscatedEmailPattern =
      /([a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64})\s*(?:\(\s*at\s*\)|\[\s*at\s*\])\s*([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+)/gi;
    const phonePattern =
      /(?:telefon|tel\.?|phone)\s*:?\s*((?:\+|00)?\d[\d\s()./–-]{4,}\d)/gi;
    const visibleContactPattern = new RegExp(
      `(?:${obfuscatedEmailPattern.source})|(?:${phonePattern.source})`,
      "i"
    );
    const sections: string[] = [];
    const directoryFallbackSections = new Set<string>();
    const addSection = (value: string): string | undefined => {
      const text = compactText(value);
      if (
        text.length >= 20 &&
        text.length <= 2_500 &&
        CONTACT_PURPOSE_PATTERN.test(text) &&
        !sections.includes(text)
      ) {
        sections.push(text);
        return text;
      }
      return undefined;
    };
    root.find("h1, h2, h3, h4, h5, h6").each((_, heading) => {
      const headingText = compactText($(heading).text());
      const section = $(heading).add(
        $(heading).nextUntil("h1, h2, h3, h4, h5, h6")
      );
      if (section.find("h1, h2, h3, h4, h5, h6").length) return;
      const text = section
        .map((__, node) => compactText($(node).text()))
        .get()
        .filter(Boolean)
        .join(" ");
      // A generic top-level heading such as "FAQ" can own thousands of
      // unrelated contacts. Treat the block as evidence only when the heading
      // itself names lost property, or when it is a genuinely small section.
      if (PAGE_LOST_PATTERN.test(headingText) || text.length <= 900) {
        addSection(text);
      }
    });
    root
      .find("summary, dt, [class*='accordion-title'], [role='button']")
      .each((_, trigger) => {
        if (!PAGE_LOST_PATTERN.test(compactText($(trigger).text()))) return;
        let context = $(trigger);
        for (let level = 0; level < 6; level += 1) {
          context = context.parent();
          if (!context.length || context.is("body")) break;
          const text = compactText(context.text());
          if (
            text.length >= 20 &&
            text.length <= 1_500 &&
            (visibleContactPattern.test(text) ||
              context.find("a[href^='mailto:'], a[href^='tel:']").length > 0)
          ) {
            addSection(text);
            break;
          }
        }
      });
    // Some municipal FAQ pages are one very long document without semantic
    // section wrappers. Scanning the whole page after seeing one "Fundsachen"
    // sentence previously attached school, tax-office and press numbers to the
    // lost-property claim. Fall back to bounded text windows around each actual
    // lost-property occurrence instead.
    if (!sections.some((section) => visibleContactPattern.test(section))) {
      const pagePhoneCount = [
        ...rootText.matchAll(new RegExp(phonePattern.source, "gi")),
      ].length;
      const pattern = new RegExp(PAGE_LOST_PATTERN.source, "gi");
      for (const match of rootText.matchAll(pattern)) {
        const index = match.index ?? 0;
        const contactHeavyDirectory = pagePhoneCount > 8;
        const section = addSection(
          rootText.slice(
            Math.max(0, index - (contactHeavyDirectory ? 0 : 420)),
            Math.min(
              rootText.length,
              index + match[0].length + (contactHeavyDirectory ? 500 : 900)
            )
          )
        );
        if (section && contactHeavyDirectory) {
          directoryFallbackSections.add(section);
        }
      }
    }
    const purposeContext = sections.length
      ? [...sections].sort(
          (left, right) => purposeScore(right) - purposeScore(left)
        )[0]
      : "";
    for (const sectionText of sections) {
      const matches = [...sectionText.matchAll(obfuscatedEmailPattern)];
      for (const match of directoryFallbackSections.has(sectionText)
        ? matches.slice(0, 1)
        : matches) {
          const value = `${match[1]}@${match[2]}`;
          if (value.length > 254) continue;
          contacts.push({
            kind: "email",
            value,
            selector: "main",
            excerpt: compactText(
              `${purposeContext} ${excerptAround(match[0], sectionText)}`
            ).slice(0, 700),
          });
      }
    }
    const addVisiblePhones = (
      sectionText: string,
      purposeContext = ""
    ): void => {
      const contactExcerpt = (needle: string): string =>
        compactText(
          purposeContext
            ? `${purposeContext} ${excerptAround(needle, sectionText)}`
            : sectionText
        ).slice(0, 700);
      const matches = [...sectionText.matchAll(phonePattern)];
      for (const match of directoryFallbackSections.has(sectionText)
        ? matches.slice(0, 1)
        : matches) {
        const value = match[1].replace(/[./–-]+$/g, "").trim();
        if (value.replace(/\D/g, "").length < 6 || value.length > 40) continue;
        contacts.push({
          kind: "phone",
          value,
          selector: "main",
          excerpt: contactExcerpt(match[0]),
        });
      }
    };
    for (const sectionText of sections) {
      addVisiblePhones(sectionText);
    }
  }

  contacts.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.value.localeCompare(right.value) ||
      purposeScore(right.excerpt) - purposeScore(left.excerpt)
  );
  return contacts
    .filter(
      (contact) =>
        !/haustier|katze|hund|schildkröte|animal|pet/i.test(contact.excerpt) ||
        /fahrrad|handy|schlüssel|gegenstände?|item|belonging/i.test(
          contact.excerpt
        )
    )
    .filter(
      (contact, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.kind === contact.kind &&
            candidate.value.toLowerCase() === contact.value.toLowerCase()
        ) === index
    );
}

export function extractPublicContactValues(
  html: string
): DiscoveredPublicContact[] {
  const $ = cheerio.load(html);
  const title = compactText($("title").first().text() || $("h1").first().text());
  const bodyText = compactText(
    primaryContentRoot($).text() || $("body").text()
  );
  return publicContactValues(
    $,
    PAGE_LOST_PATTERN.test(`${title} ${bodyText.slice(0, 100_000)}`),
    PAGE_LOST_PATTERN.test(title)
  );
}

function excerptAroundText(
  text: string,
  index: number,
  matchLength: number,
  before = 220,
  after = 320
): string {
  return compactText(
    text.slice(
      Math.max(0, index - before),
      Math.min(text.length, index + matchLength + after)
    )
  );
}

/**
 * PDFs have no anchors or semantic DOM, so only publish contacts when the
 * extracted document itself explicitly mentions lost property. The evidence
 * excerpt combines that purpose statement with the nearby public contact.
 */
export function extractPublicContactValuesFromText(
  rawText: string
): DiscoveredPublicContact[] {
  const text = compactText(rawText);
  const lostIndex = text.search(PAGE_LOST_PATTERN);
  if (lostIndex < 0) return [];
  const lostMatch = text.slice(lostIndex).match(PAGE_LOST_PATTERN)?.[0] ?? "";
  const purposeExcerpt = excerptAroundText(
    text,
    lostIndex,
    lostMatch.length,
    100,
    300
  ).slice(0, 420);
  const contacts: DiscoveredPublicContact[] = [];

  for (const match of text.matchAll(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
  )) {
    const index = match.index ?? 0;
    contacts.push({
      kind: "email",
      value: match[0],
      selector: "PDF text",
      excerpt: compactText(
        `${purposeExcerpt} Contact: ${excerptAroundText(
          text,
          index,
          match[0].length,
          160,
          160
        )}`
      ).slice(0, 700),
    });
  }
  for (const match of text.matchAll(
    /(?:telefon|tel\.?|phone|hotline)\s*:?\s*((?:\+|00)?\d[\d\s()./–-]{4,}\d)/gi
  )) {
    const value = match[1].replace(/[./–-]+$/g, "").trim();
    if (value.replace(/\D/g, "").length < 6 || value.length > 40) continue;
    const index = match.index ?? 0;
    contacts.push({
      kind: "phone",
      value,
      selector: "PDF text",
      excerpt: compactText(
        `${purposeExcerpt} Contact: ${excerptAroundText(
          text,
          index,
          match[0].length,
          160,
          160
        )}`
      ).slice(0, 700),
    });
  }

  return contacts
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.value.localeCompare(right.value)
    )
    .filter(
      (contact, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.kind === contact.kind &&
            candidate.value.toLowerCase() === contact.value.toLowerCase()
        ) === index
    );
}

/**
 * Extract a conservative fallback from a venue's exact official page. Unlike
 * lost-page contacts, only values inside a clearly labelled contact section
 * are returned; navigation and footer-wide organisation contacts are ignored.
 */
export function extractOfficialVenueContactValues(
  html: string,
  wholeContactPage = false
): DiscoveredPublicContact[] {
  const $ = cheerio.load(html);
  const root = $("body");
  const contacts: DiscoveredPublicContact[] = [];
  root.find("h1, h2, h3, h4, h5, h6").each((_, heading) => {
    if ($(heading).closest("nav, header, footer").length) return;
    const headingText = compactText($(heading).text());
    if (
      !/^(?:(?:ihr|your)\s+)?(?:kontakt|contact|ansprechpartner(?:in)?|visitor (?:contact|service)|besucherservice)$/i.test(
        headingText
      )
    ) {
      return;
    }
    const section = $(heading)
      .add($(heading).nextUntil("h1, h2, h3, h4, h5, h6"));
    const sectionText = section
      .find("*")
      .addBack()
      .contents()
      .filter((_, node) => node.type === "text")
      .map((_, node) => compactText($(node).text()))
      .get()
      .filter(Boolean)
      .join(" ")
      .slice(0, 1_500);
    if (!sectionText) return;
    section.find("a[href]").each((_, anchor) => {
      const href = ($(anchor).attr("href") ?? "").trim();
      if (/^mailto:/i.test(href)) {
        let value = href.slice("mailto:".length).split("?")[0].trim();
        try {
          value = decodeURIComponent(value);
        } catch {
          // Keep a malformed-but-public literal for the reviewer.
        }
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          contacts.push({
            kind: "email",
            value,
            selector: 'a[href^="mailto:"]',
            excerpt: sectionText,
          });
        }
      } else if (/^tel:/i.test(href)) {
        let value = href.slice("tel:".length).split("?")[0].trim();
        try {
          value = decodeURIComponent(value);
        } catch {
          // Keep a malformed-but-public literal for the reviewer.
        }
        if (/[a-z]/i.test(value)) return;
        value = value.replace(/[^\d+() .-]/g, "").trim();
        if (value.replace(/\D/g, "").length >= 6 && value.length <= 40) {
          contacts.push({
            kind: "phone",
            value,
            selector: 'a[href^="tel:"]',
            excerpt: sectionText,
          });
        }
      }
    });
    for (const match of sectionText.matchAll(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
    )) {
      contacts.push({
        kind: "email",
        value: match[0],
        selector: "main",
        excerpt: sectionText,
      });
    }
    for (const match of sectionText.matchAll(
      /(?:\+49|0)\s?\d{2,5}(?:[\s./()-]*\d){5,}/g
    )) {
      const value = match[0].replace(/[./-]+$/g, "").trim();
      if (value.replace(/\D/g, "").length >= 7 && value.length <= 40) {
        contacts.push({
          kind: "phone",
          value,
          selector: "main",
          excerpt: sectionText,
        });
      }
    }
  });
  if (wholeContactPage) {
    const preferred = primaryContentRoot($);
    const pageRoot = (preferred.length ? preferred : $("body")).clone();
    pageRoot.find("nav, header, footer, aside, script, style, noscript").remove();
    const pageText = compactText(
      pageRoot
        .find("*")
        .addBack()
        .contents()
        .filter((_, node) => node.type === "text")
        .map((_, node) => $(node).text())
        .get()
        .join(" ")
    ).slice(0, 20_000);
    const localExcerpt = (node: Element, value: string): string => {
      let context = $(node);
      let fallback = value;
      for (let level = 0; level < 5; level += 1) {
        context = context.parent();
        if (!context.length || context.is("body")) break;
        const text = compactText(context.text());
        if (text.length >= 12 && text.length <= 700) fallback = text;
        if (context.is("p, li, address, section, article")) break;
      }
      return fallback.slice(0, 700);
    };
    pageRoot.find("a[href]").each((_, anchor) => {
      const href = ($(anchor).attr("href") ?? "").trim();
      if (/^mailto:/i.test(href)) {
        let value = href.slice("mailto:".length).split("?")[0].trim();
        try {
          value = decodeURIComponent(value);
        } catch {
          // Keep a malformed-but-public literal for review.
        }
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          contacts.push({
            kind: "email",
            value,
            selector: 'a[href^="mailto:"]',
            excerpt: localExcerpt(anchor, value),
          });
        }
      } else if (/^tel:/i.test(href)) {
        let value = href.slice("tel:".length).split("?")[0].trim();
        try {
          value = decodeURIComponent(value);
        } catch {
          // Keep a malformed-but-public literal for review.
        }
        value = value.replace(/[^\d+() .\/-]/g, "").trim();
        if (value.replace(/\D/g, "").length >= 6 && value.length <= 40) {
          contacts.push({
            kind: "phone",
            value,
            selector: 'a[href^="tel:"]',
            excerpt: localExcerpt(anchor, value),
          });
        }
      }
    });
    const obfuscatedEmailPattern =
      /([a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64})\s*(?:@|\(\s*at\s*\)|\[\s*at\s*\])\s*([a-z0-9-]+(?:(?:\.[a-z0-9-]+)|(?:\s*(?:\(\s*dot\s*\)|\[\s*dot\s*\])\s*[a-z0-9-]+))+)/gi;
    for (const match of pageText.matchAll(obfuscatedEmailPattern)) {
      const domain = match[2]
        .replace(/\s*(?:\(\s*dot\s*\)|\[\s*dot\s*\])\s*/gi, ".")
        .replace(/\s+/g, "");
      const value = `${match[1]}@${domain}`;
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        const index = match.index ?? 0;
        contacts.push({
          kind: "email",
          value,
          selector: "main",
          excerpt: pageText.slice(Math.max(0, index - 180), index + match[0].length + 260),
        });
      }
    }
    const labelledPhonePattern =
      /(?:telefon|tel\.?|phone|fon)\s*:?\s*((?:\+|00)?\d[\d\s()./–-]{4,}\d)/gi;
    for (const match of pageText.matchAll(labelledPhonePattern)) {
      const value = match[1].replace(/[./–-]+$/g, "").trim();
      if (value.replace(/\D/g, "").length < 6 || value.length > 40) continue;
      const index = match.index ?? 0;
      contacts.push({
        kind: "phone",
        value,
        selector: "main",
        excerpt: pageText.slice(Math.max(0, index - 180), index + match[0].length + 260),
      });
    }
  }
  const publicContactScore = (contact: DiscoveredPublicContact): number => {
    const text = `${contact.value} ${contact.excerpt}`.toLowerCase();
    const localPart =
      contact.kind === "email" ? contact.value.split("@")[0] : "";
    let score = 0;
    if (
      /(?:^|[._-])(info|kontakt|contact|service|besucher|visitor|museum|office|hello|mail|fund|lost|rezeption|reception|kasse)(?:[._-]|$)/i.test(
        localPart
      )
    ) {
      score += 80;
    }
    if (/besucherservice|visitor service|allgemein|general|kontakt|contact|information|rezeption|reception|kasse/i.test(text)) {
      score += 35;
    }
    if (/presse|press|marketing|bewerbung|career|jobs?|datenschutz|privacy|vermietung|rental|technik|dramaturgie/i.test(text)) {
      score -= 60;
    }
    return score;
  };
  const unique = contacts
    .sort(
      (left, right) =>
        publicContactScore(right) - publicContactScore(left) ||
        left.kind.localeCompare(right.kind) ||
        left.value.localeCompare(right.value)
    )
    .filter(
      (contact, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.kind === contact.kind &&
            candidate.value.toLowerCase() === contact.value.toLowerCase()
        ) === index
    );
  if (!wholeContactPage) return unique;
  const emailCandidates = unique.filter((contact) => contact.kind === "email");
  const preferredEmails = emailCandidates.filter(
    (contact) => publicContactScore(contact) > 0
  );
  const emails = (preferredEmails.length ? preferredEmails : emailCandidates).slice(
    0,
    3
  );
  const phones = unique.filter((contact) => contact.kind === "phone").slice(0, 2);
  return [...emails, ...phones].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value)
  );
}

function officialFallbackCandidateScore(candidate: ChannelCandidate): number {
  const value = candidate.contactValue?.toLowerCase() ?? "";
  const localPart = candidate.kind === "email" ? value.split("@")[0] : "";
  const source = `${candidate.pageUrl} ${candidate.evidence
    .map((evidence) => evidence.excerpt ?? "")
    .join(" ")}`.toLowerCase();
  let score = candidate.kind === "email" ? 25 : 0;
  if (
    /(?:^|[._-])(info|kontakt|contact|service|besucher|visitor|visit|museum|office|hello|mail|post|fund|lost|rezeption|reception|kasse|karten|hilfe)(?:[._-]|$)/i.test(
      localPart
    )
  ) {
    score += 100;
  }
  if (
    /besucherservice|visitor service|allgemein|general|kontakt|contact|information|rezeption|reception|kasse|ticket office/i.test(
      source
    )
  ) {
    score += 35;
  }
  if (/\/kontakt|\/contact|besucherservice|visitor-service|\/hilfe|\/help/i.test(candidate.pageUrl)) {
    score += 25;
  }
  if (/impressum|imprint/i.test(candidate.pageUrl)) score -= 15;
  if (
    /presse|press|marketing|newsletter|bewerbung|career|jobs?|datenschutz|privacy|vermietung|rental|technik|dramaturgie|direktion|director/i.test(
      `${value} ${source}`
    )
  ) {
    score -= 100;
  }
  if (candidate.kind === "email") {
    try {
      const pageHost = new URL(candidate.pageUrl).hostname.replace(/^www\./, "");
      const mailHost = value.split("@")[1]?.replace(/^www\./, "");
      if (
        pageHost &&
        mailHost &&
        (pageHost === mailHost ||
          pageHost.endsWith(`.${mailHost}`) ||
          mailHost.endsWith(`.${pageHost}`))
      ) {
        score += 25;
      } else {
        score -= 25;
      }
    } catch {
      // The candidate URL is validated earlier; an unexpected parse failure
      // simply receives no same-site bonus.
    }
  }
  return score;
}

/**
 * A venue needs one useful general fallback, not every department address
 * published across its contact, team and imprint pages. Lost-property-specific
 * destinations and extracted forms remain untouched.
 */
export function selectOfficialFallbackCandidates(
  scopeCandidates: ChannelCandidate[]
): ChannelCandidate[] {
  const generic = scopeCandidates.filter((candidate) =>
    candidate.reasons.includes(
      "no lost-property-specific purpose was confirmed"
    )
  );
  if (generic.length <= 1) return scopeCandidates;
  const [best] = [...generic].sort(
    (left, right) =>
      officialFallbackCandidateScore(right) -
        officialFallbackCandidateScore(left) ||
      right.confidence - left.confidence ||
      left.pageUrl.localeCompare(right.pageUrl) ||
      (left.contactValue ?? "").localeCompare(right.contactValue ?? "")
  );
  return scopeCandidates.filter(
    (candidate) => !generic.includes(candidate) || candidate === best
  );
}

export function isRelevantDiscoveredForm(
  form: import("./schemas").FormSnapshot,
  contactPage: boolean
): boolean {
  const visibleFields = form.fields.filter(
    (field) => field.control !== "hidden"
  );
  const semanticKeys = new Set<string>(
    visibleFields.map((field) => field.semanticKey)
  );
  const lostSpecificFields = [
    "lossDate",
    "lossTime",
    "lossLocation",
    "itemCategory",
    "itemDescription",
  ].filter((key) => semanticKeys.has(key)).length;
  const purposeText = `${new URL(form.pageUrl).pathname} ${form.title} ${
    form.contextText
  } ${form.formAction ?? ""}`;
  const looksLikeGeneralContact =
    contactPage &&
    !IRRELEVANT_GENERAL_CONTACT_PATTERN.test(purposeText) &&
    visibleFields.length >= 2 &&
    visibleFields.some(
      (field) =>
        field.semanticKey === "email" ||
        field.semanticKey === "phone" ||
        field.semanticKey === "fullName"
    ) &&
    visibleFields.some(
      (field) =>
        field.semanticKey === "messageBody" || field.control === "textarea"
    ) &&
    !/newsletter|search|suche|site search/i.test(
      `${form.contextText} ${form.formAction ?? ""}`
    );
  return (
    visibleFields.length > 0 &&
    (PAGE_LOST_PATTERN.test(form.contextText) ||
      lostSpecificFields >= 2 ||
      looksLikeGeneralContact)
  );
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function discoverChannels(options: {
  inventoryPath: string;
  outputPath: string;
  domain?: string;
  domainLimit?: number;
  maxPagesPerDomain?: number;
  maxDepth?: number;
  delayMs?: number;
  domainTimeoutMs?: number;
  shardIndex?: number;
  shardCount?: number;
  renderDynamic?: boolean;
  resume?: boolean;
  checkpoint?: boolean;
  onProgress?: (message: string) => void;
}): Promise<CandidateFile> {
  const inventory = JSON.parse(
    await readFile(options.inventoryPath, "utf8")
  ) as InventoryFile;
  const seedGroups = buildDiscoverySeedGroups(inventory, options.domain);

  const shardCount = Math.max(1, options.shardCount ?? 1);
  const shardIndex = options.shardIndex ?? 0;
  if (shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(`shardIndex must be between 0 and ${shardCount - 1}`);
  }
  const groups = seedGroups
    // Every scope for one origin stays in one worker. This lets different
    // official sites run concurrently without hitting the same site from
    // several workers or bypassing its per-request delay.
    .filter(
      (group) => crawlShardForOrigin(group.origin, shardCount) === shardIndex
    )
    .slice(
    0,
    options.domainLimit ?? Number.POSITIVE_INFINITY
    );
  let previous: CandidateFile | undefined;
  if (options.resume) {
    try {
      const parsed = JSON.parse(
        await readFile(options.outputPath, "utf8")
      ) as CandidateFile;
      if (parsed.version === 1) previous = parsed;
    } catch {
      // A missing output simply starts a new resumable crawl.
    }
  }
  const candidates: ChannelCandidate[] = [...(previous?.candidates ?? [])];
  const failures: CandidateFile["failures"] = [...(previous?.failures ?? [])];
  const completedScopes = [...(previous?.completedScopes ?? [])];
  const completedScopeIds = new Set(
    completedScopes.map((checkpoint) => checkpoint.scopeId)
  );
  const candidateKeys = new Set<string>();
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const robotsCache = new Map<string, RobotsPolicy>();
  // All owner scopes for one origin are assigned to the same shard. Sharing
  // network responses here therefore keeps politeness and ownership separate:
  // the site is downloaded once, while each venue still receives its own
  // attribution pass and checkpoint.
  const textLoads = createCanonicalLoadCache<SafeFetchResult>();
  const byteLoads = createCanonicalLoadCache<SafeFetchBytesResult>();
  const pdfTextCache = new Map<
    string,
    Awaited<ReturnType<typeof extractPdfText>>
  >();

  const outputSnapshot = (): CandidateFile => ({
    version: 1,
    generatedAt: new Date().toISOString(),
    candidates: [...candidates].sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.pageUrl.localeCompare(right.pageUrl)
    ),
    failures: [
      ...new Map(
        failures.map((failure) => [
          `${failure.seedUrl}|${failure.error}`,
          failure,
        ])
      ).values(),
    ],
    completedScopes: [...completedScopes].sort((left, right) =>
      left.scopeId.localeCompare(right.scopeId)
    ),
  });
  const writeSnapshot = async (): Promise<CandidateFile> => {
    const output = outputSnapshot();
    await mkdir(dirname(options.outputPath), { recursive: true });
    const temporaryPath = `${options.outputPath}.tmp-${process.pid}`;
    await writeFile(temporaryPath, `${JSON.stringify(output, null, 2)}\n`);
    await rename(temporaryPath, options.outputPath);
    return output;
  };

  const getRobots = async (
    url: URL,
    timeoutMs = 20_000
  ): Promise<RobotsPolicy> => {
    const cached = robotsCache.get(url.origin);
    if (cached) return cached;
    const robotsUrl = new URL("/robots.txt", url.origin).toString();
    try {
      const response = await safeFetchText(robotsUrl, {
        maxBytes: 512_000,
        accept: "text/plain",
        timeoutMs,
      });
      const policy = robotsParser(robotsUrl, response.status === 200 ? response.body : "");
      robotsCache.set(url.origin, policy);
      return policy;
    } catch {
      const policy = robotsParser(robotsUrl, "");
      robotsCache.set(url.origin, policy);
      return policy;
    }
  };

  for (const group of groups) {
    const { origin } = group;
    const domainStartedAt = Date.now();
    const domainTimeoutMs = options.domainTimeoutMs ?? 45_000;
    const domainDeadline = domainStartedAt + domainTimeoutMs;
    const remainingDomainTime = (requestLimitMs = 20_000): number => {
      const remaining = domainDeadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Domain time budget exceeded after ${domainTimeoutMs} ms: ${origin}`
        );
      }
      return Math.max(1, Math.min(requestLimitMs, remaining));
    };
    const ownerScopeKey = [
      ...[...group.operatorIds].map((id) => `operator:${id}`),
      ...[...group.venueIds].sort().map((id) => `venue:${id}`),
    ].join("|");
    const scopeId = discoveryScopeId(group);
    if (completedScopeIds.has(scopeId)) {
      options.onProgress?.(`Skipped completed scope ${origin}`);
      continue;
    }
    const failureCountBeforeScope = failures.length;
    const candidateCountBeforeScope = candidates.length;
    const seedOrigin = new URL(origin);
    const queue: QueueEntry[] = group.seeds.map((seed) => ({
      url: canonicalUrl(seed),
      depth: 0,
      path: [{ url: canonicalUrl(seed), label: "official website" }],
      externalLeaf: false,
      priority: 200,
    }));
    const seen = new Set<string>();
    let pagesRead = 0;
    let externalLeaves = 0;

    const seedRobots = await getRobots(
      seedOrigin,
      remainingDomainTime()
    );
    for (const sitemapUrl of seedRobots.getSitemaps().slice(0, 3)) {
      try {
        const { value: sitemapResponse } = await textLoads.load(
          sitemapUrl,
          () =>
            safeFetchText(sitemapUrl, {
              maxBytes: 2_000_000,
              accept: "application/xml,text/xml,text/plain",
              timeoutMs: remainingDomainTime(),
            })
        );
        const sitemapUrls = [
          ...sitemapResponse.body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi),
        ]
          .map((match) => match[1].replaceAll("&amp;", "&"))
          .map((url) => {
            try {
              return canonicalUrl(url);
            } catch {
              return "";
            }
          })
          .filter(Boolean)
          .filter((url) => {
            const parsed = new URL(url);
            return (
              sameSiteHost(seedOrigin, parsed) &&
              !shouldSkipDiscoveryUrl(url) &&
              linkPriority(url, "") > 0
            );
          })
          .slice(0, 40);
        for (const url of sitemapUrls) {
          queue.push({
            url,
            depth: 1,
            path: [
              { url: origin, label: "official website" },
              { url, label: "sitemap candidate" },
            ],
            externalLeaf: false,
            priority: linkPriority(url, ""),
          });
        }
      } catch {
        // A broken or protected sitemap does not prevent normal navigation discovery.
      }
    }

    while (queue.length && pagesRead < (options.maxPagesPerDomain ?? 60)) {
      if (Date.now() >= domainDeadline) {
        failures.push({
          seedUrl: origin,
          venueIds: [...group.venueIds].sort(),
          error: `Domain time budget exceeded after ${domainTimeoutMs} ms`,
        });
        options.onProgress?.(
          `Timed out ${origin} after ${domainTimeoutMs} ms; moving to the next scope`
        );
        break;
      }
      queue.sort((left, right) => right.priority - left.priority || left.depth - right.depth);
      // The queue is ordered by how promising a link looks, so once nothing
      // scoring above zero is left there is only ordinary site content ahead.
      // Spending the rest of the page budget on it costs a fixed delay per
      // request and, on a site that has already yielded a channel, finds
      // nothing further. Stop instead and move to the next domain.
      if (
        candidates.length > candidateCountBeforeScope &&
        (queue[0]?.priority ?? 0) <= 0
      ) {
        options.onProgress?.(
          `Stopping ${origin} early: ${pagesRead} pages read, no promising links left`
        );
        break;
      }
      const entry = queue.shift();
      if (!entry || seen.has(entry.url)) continue;
      seen.add(entry.url);
      let entryUrl: URL;
      try {
        entryUrl = new URL(entry.url);
      } catch {
        continue;
      }
      const policy = await getRobots(
        entryUrl,
        remainingDomainTime()
      );
      if (policy.isAllowed(entry.url, ROBOT_NAME) === false) continue;

      try {
        if (/\.pdf(?:$|[?#])/i.test(entryUrl.pathname)) {
          const { value: response } = await byteLoads.load(
            entry.url,
            async () => {
              await sleep(options.delayMs ?? 900);
              return safeFetchBytes(entry.url, {
                maxBytes: 8_000_000,
                accept: "application/pdf",
                timeoutMs: Math.min(30_000, remainingDomainTime()),
              });
            }
          );
          pagesRead += 1;
          if (response.status < 200 || response.status >= 400) continue;
          const contentType =
            response.headers.get("content-type")?.toLowerCase() ?? "";
          const hasPdfSignature =
            response.body.length >= 5 &&
            new TextDecoder("ascii")
              .decode(response.body.slice(0, 5))
              .startsWith("%PDF-");
          if (!contentType.includes("pdf") && !hasPdfSignature) continue;

          const finalUrl = canonicalUrl(response.url);
          const pdfCacheKey = candidateUrlIdentity(finalUrl);
          let pdf = pdfTextCache.get(pdfCacheKey);
          if (!pdf) {
            pdf = await extractPdfText(response.body);
            pdfTextCache.set(pdfCacheKey, pdf);
          }
          if (
            !PAGE_LOST_PATTERN.test(
              `${finalUrl} ${pdf.title} ${pdf.bodyText.slice(0, 200_000)}`
            )
          ) {
            continue;
          }
          const pageEvidence = {
            title: pdf.title,
            bodyText: pdf.bodyText,
          };
          for (const contact of extractPublicContactValuesFromText(
            pdf.bodyText
          )) {
            const contactKey = `${ownerScopeKey}|${contact.kind}|${contact.value.toLowerCase()}`;
            const candidateId = stableId("channel", contactKey);
            if (candidateKeys.has(contactKey) || candidateIds.has(candidateId)) continue;
            candidateKeys.add(contactKey);
            candidateIds.add(candidateId);
            const observedAt = new Date().toISOString();
            candidates.push({
              id: candidateId,
              operatorId:
                group.operatorIds.size === 1
                  ? [...group.operatorIds][0]
                  : undefined,
              venueIds: [...group.venueIds].sort(),
              kind: contact.kind,
              pageUrl: finalUrl,
              contactValue: contact.value,
              confidence: contact.kind === "email" ? 70 : 65,
              reasons: [
                "linked from the official seed site",
                "official PDF explicitly mentions lost property",
                `official PDF publishes ${
                  contact.kind === "email" ? "an email" : "a phone"
                } contact`,
              ],
              discoveryPath: entry.path,
              evidence: [
                {
                  sourceUrl: finalUrl,
                  selector: contact.selector,
                  excerpt: contact.excerpt,
                  contentHash: pageEvidenceHash(pageEvidence),
                  observedAt,
                },
              ],
              fetchStatus: "ok",
              reviewStatus: "candidate",
              discoveredAt: observedAt,
            });
          }
          continue;
        }

        const { value: response } = await textLoads.load(
          entry.url,
          async () => {
            await sleep(options.delayMs ?? 900);
            return safeFetchText(entry.url, {
              timeoutMs: remainingDomainTime(),
            });
          }
        );
        pagesRead += 1;
        if (response.status < 200 || response.status >= 400) continue;
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (
          contentType &&
          !contentType.includes("html") &&
          !contentType.includes("xhtml")
        ) {
          continue;
        }
        const finalUrl = canonicalUrl(response.url);
        const $ = cheerio.load(response.body);
        const pageEvidence = pageEvidenceFromHtml(response.body);
        const { title, bodyText } = pageEvidence;
        const forms = extractFormsFromHtml({ html: response.body, pageUrl: finalUrl });
        const pageHasLostEvidence = PAGE_LOST_PATTERN.test(
          `${finalUrl} ${title} ${bodyText.slice(0, 100_000)}`
        );
        const pageLooksRelevant =
          pageHasLostEvidence ||
          (CONTACT_PAGE_PATTERN.test(`${finalUrl} ${title}`) &&
            (forms.length > 0 || options.renderDynamic));

        if (pageLooksRelevant) {
          const contactPage = CONTACT_PAGE_PATTERN.test(`${finalUrl} ${title}`);
          let relevantForms = forms.filter((form) =>
            isRelevantDiscoveredForm(form, contactPage)
          );
          if (options.renderDynamic && relevantForms.length === 0) {
            try {
              const rendered = await extractRenderedForms(finalUrl, {
                explore: true,
                maxStates: 8,
              });
              relevantForms = rendered.forms.filter((form) =>
                isRelevantDiscoveredForm(form, contactPage)
              );
            } catch {
              // The static page remains a reviewable lead if browser rendering is unavailable.
            }
          }
          const pageForms = relevantForms.length
            ? relevantForms
            : pageHasLostEvidence
              ? [undefined]
              : [];
          for (const [formIndex, form] of pageForms.entries()) {
            const candidatePageUrl = form?.pageUrl ?? finalUrl;
            const scored = scoreCandidate({
              url: candidatePageUrl,
              title,
              text: bodyText,
              form,
              linkedFromOfficialSeed: true,
            });
            const key = formCandidateId({
              ownerScopeKey,
              pageUrl: candidatePageUrl,
              formIndex,
              hasForm: Boolean(form),
            });
            if (candidateKeys.has(key) || candidateIds.has(key)) continue;
            candidateKeys.add(key);
            candidateIds.add(key);
            const observedAt = new Date().toISOString();
            candidates.push({
              id: key,
              operatorId:
                group.operatorIds.size === 1 ? [...group.operatorIds][0] : undefined,
              venueIds: [...group.venueIds].sort(),
              kind: scored.kind,
              pageUrl: candidatePageUrl,
              form,
              confidence: scored.confidence,
              reasons: scored.reasons,
              discoveryPath:
                form?.pageUrl && form.pageUrl !== finalUrl
                  ? [
                      ...entry.path,
                      { url: form.pageUrl, label: "embedded official form" },
                    ]
                  : entry.path,
              evidence: [
                {
                  sourceUrl: finalUrl,
                  excerpt: bodyText.slice(0, 500),
                  contentHash: pageEvidenceHash(
                    pageEvidence,
                    form?.contentHash
                  ),
                  observedAt,
                },
              ],
              fetchStatus: "ok",
              reviewStatus:
                scored.kind === "manual_review" ? "needs_review" : "candidate",
              discoveredAt: observedAt,
            });
          }
          if (pageHasLostEvidence) {
            const titleOrUrlNamesLostProperty = PAGE_LOST_PATTERN.test(
              `${finalUrl} ${title}`
            );
            for (const contact of publicContactValues(
              $,
              true,
              titleOrUrlNamesLostProperty,
              false
            )) {
              const contactKey = `${ownerScopeKey}|${contact.kind}|${contact.value.toLowerCase()}`;
              const candidateId = stableId("channel", contactKey);
              if (candidateKeys.has(contactKey) || candidateIds.has(candidateId)) continue;
              candidateKeys.add(contactKey);
              candidateIds.add(candidateId);
              const observedAt = new Date().toISOString();
              candidates.push({
                id: candidateId,
                operatorId:
                  group.operatorIds.size === 1
                    ? [...group.operatorIds][0]
                    : undefined,
                venueIds: [...group.venueIds].sort(),
                kind: contact.kind,
                pageUrl: finalUrl,
                contactValue: contact.value,
                confidence: contact.kind === "email" ? 70 : 65,
                reasons: [
                  "linked from the official seed site",
                  "page explicitly mentions lost property",
                  `page publishes an official ${contact.kind} contact`,
                ],
                discoveryPath: entry.path,
                evidence: [
                  {
                    sourceUrl: finalUrl,
                    selector: contact.selector,
                    excerpt: contact.excerpt.slice(0, 700),
                    contentHash: pageEvidenceHash(pageEvidence),
                    observedAt,
                  },
                ],
                fetchStatus: "ok",
                reviewStatus: "candidate",
                discoveredAt: observedAt,
              });
            }
          }
        }

        const officialFallbackPage =
          entry.depth === 0 ||
          CONTACT_PAGE_PATTERN.test(`${finalUrl} ${title}`);
        if (officialFallbackPage && !pageHasLostEvidence) {
          for (const contact of extractOfficialVenueContactValues(
            response.body,
            entry.depth > 0 || CONTACT_PAGE_PATTERN.test(`${finalUrl} ${title}`)
          )) {
            const contactKey = `${ownerScopeKey}|official-venue-fallback|${
              contact.kind
            }|${contact.value.toLowerCase()}`;
            const candidateId = stableId("channel", contactKey);
            if (candidateKeys.has(contactKey) || candidateIds.has(candidateId)) continue;
            candidateKeys.add(contactKey);
            candidateIds.add(candidateId);
            const observedAt = new Date().toISOString();
            candidates.push({
              id: candidateId,
              operatorId:
                group.operatorIds.size === 1
                  ? [...group.operatorIds][0]
                  : undefined,
              venueIds: [...group.venueIds].sort(),
              kind: contact.kind,
              pageUrl: finalUrl,
              contactValue: contact.value,
              confidence: contact.kind === "email" ? 45 : 40,
              reasons: [
                group.operatorIds.size === 1
                  ? "published on the exact official operator contact page"
                  : "published on the exact official venue contact page",
                "no lost-property-specific purpose was confirmed",
                "review as a venue fallback before use",
              ],
              discoveryPath: entry.path,
              evidence: [
                {
                  sourceUrl: finalUrl,
                  selector: contact.selector,
                  excerpt: contact.excerpt,
                  contentHash: pageEvidenceHash(pageEvidence),
                  observedAt,
                },
              ],
              fetchStatus: "ok",
              reviewStatus: "needs_review",
              discoveredAt: observedAt,
            });
          }
        }

        if (
          entry.externalLeaf ||
          entry.depth >= (options.maxDepth ?? 3)
        ) {
          continue;
        }
        const current = new URL(finalUrl);
        $("a[href]").each((_, anchor) => {
          const href = $(anchor).attr("href");
          const label = compactText($(anchor).text());
          if (!href) return;
          let target: URL;
          try {
            target = new URL(href, current);
          } catch {
            return;
          }
          if (!["http:", "https:"].includes(target.protocol)) {
            return;
          }
          const url = canonicalUrl(target.toString());
          const priority = linkPriority(url, label);
          if (
            shouldSkipDiscoveryUrl(url) ||
            (/\.pdf(?:$|[?#])/i.test(target.pathname) && priority <= 0)
          ) {
            return;
          }
          const sameSite = sameSiteHost(seedOrigin, target);
          if (!sameSite && (priority < 100 || externalLeaves >= 8)) return;
          if (!sameSite) externalLeaves += 1;
          if (!sameSite || priority > 0 || entry.depth < 1) {
            queue.push({
              url,
              depth: entry.depth + 1,
              path: [...entry.path, { url, label: label || target.pathname }],
              externalLeaf: !sameSite,
              priority,
            });
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const domainTimedOut = Date.now() >= domainDeadline;
        if (entry.depth === 0 || domainTimedOut) {
          failures.push({
            seedUrl: entry.url,
            venueIds: [...group.venueIds].sort(),
            error: domainTimedOut
              ? `Domain time budget exceeded after ${domainTimeoutMs} ms`
              : message,
          });
        }
        if (domainTimedOut) {
          options.onProgress?.(
            `Timed out ${origin} after ${domainTimeoutMs} ms; moving to the next scope`
          );
          break;
        }
      }
    }
    const selectedScopeCandidates = selectOfficialFallbackCandidates(
      candidates.slice(candidateCountBeforeScope)
    );
    if (
      selectedScopeCandidates.length <
      candidates.length - candidateCountBeforeScope
    ) {
      candidates.splice(
        candidateCountBeforeScope,
        candidates.length - candidateCountBeforeScope,
        ...selectedScopeCandidates
      );
    }
    const scopeSucceeded = failures.length === failureCountBeforeScope;
    if (scopeSucceeded) {
      const completedAt = new Date().toISOString();
      completedScopes.push({
        scopeId,
        origin,
        venueIds: [...group.venueIds].sort(),
        completedAt,
      });
      completedScopeIds.add(scopeId);
    }
    if (options.checkpoint !== false) await writeSnapshot();
    options.onProgress?.(
      `${scopeSucceeded ? "Completed" : "Saved incomplete"} ${origin}: ${candidates.length} candidates total`
    );
  }
  return writeSnapshot();
}
