import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { extractRenderedForms } from "./browser.mjs";
import { extractFormsFromHtml } from "./form-extractor.mjs";
import { stableId } from "./hash.mjs";
import {
  pageEvidenceFromHtml,
  pageEvidenceHash,
} from "./page-evidence.mjs";
import { safeFetchText } from "./safe-fetch.mjs";
import { scoreCandidate } from "./scoring.mjs";
import type {
  CandidateFile,
  ChannelCandidate,
  DiscoveryPathStep,
  InventoryFile,
} from "./schemas";

const ROBOT_NAME = "Berlin-Lost-Found-Channel-Research";
const LOST_PATTERN =
  /fundbüro|fundbuero|fundsache|verlust|verloren|lost[- ]?found|lost property/i;
const PAGE_LOST_PATTERN =
  /fundbüro|fundbuero|fundsache|verlustmeldung|gegenstand.{0,30}verloren|verloren.{0,30}gegenstand|lost[- ]?found|lost property/i;
const CONTACT_PATTERN =
  /kontakt|contact|besucherservice|visitor service|gästeservice|service|hilfe|faq/i;
const CONTACT_PAGE_PATTERN =
  /kontakt|contact|besucherservice|visitor service|gästeservice/i;
const SKIP_PATTERN =
  /\/(news|presse|press|karriere|jobs|shop|tickets?|events?|kalender|calendar|datenschutz|privacy|impressum|legal|sitemap)(\/|$)|\.(?:jpe?g|png|gif|webp|svg|pdf|zip|mp[34]|ics)$/i;

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

export interface DiscoverySeedGroup {
  origin: string;
  seeds: string[];
  venueIds: Set<string>;
  operatorIds: Set<string>;
}

export function buildDiscoverySeedGroups(
  inventory: InventoryFile,
  domain?: string
): DiscoverySeedGroup[] {
  const groupsByOwner = new Map<string, DiscoverySeedGroup>();
  const entityVenueIds = new Map(
    inventory.entityGroups.map((group) => [group.id, group.venueIds])
  );
  for (const venue of inventory.venues) {
    const seed = venue.officialWebsite ?? venue.operatorWebsite;
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
    const usesOperatorSeed =
      !venue.officialWebsite &&
      Boolean(venue.operatorId && venue.operatorWebsite);
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
    if (!existing.seeds.includes(url.toString())) {
      existing.seeds.push(url.toString());
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

function canonicalUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function linkPriority(url: string, label: string): number {
  const text = `${url} ${label}`;
  if (LOST_PATTERN.test(text)) return 100;
  if (CONTACT_PATTERN.test(text)) return 30;
  return 0;
}

function sameSiteHost(left: URL, right: URL): boolean {
  const normalize = (hostname: string) => hostname.replace(/^www\./, "").toLowerCase();
  return normalize(left.hostname) === normalize(right.hostname);
}

function publicContactValues(
  $: cheerio.CheerioAPI,
  dedicatedPage: boolean
): Array<{ kind: "email" | "phone"; value: string; selector: string }> {
  const preferred = $("main, article, [role='main']").first();
  const root = preferred.length ? preferred : $("body");
  const contacts: Array<{
    kind: "email" | "phone";
    value: string;
    selector: string;
  }> = [];
  root.find("a[href]").each((_, anchor) => {
    if (!dedicatedPage) {
      let context = $(anchor);
      let locallyRelevant = false;
      for (let level = 0; level < 4; level += 1) {
        context = context.parent();
        if (!context.length || context.is("main, body")) break;
        if (PAGE_LOST_PATTERN.test(compactText(context.text()))) {
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
        });
      }
    } else if (/^tel:/i.test(href)) {
      let value = href.slice("tel:".length).split("?")[0].trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        // Retain the literal public value if its escaping is malformed.
      }
      value = value.replace(/[^\d+() .-]/g, "").trim();
      if (value.replace(/\D/g, "").length >= 6 && value.length <= 40) {
        contacts.push({
          kind: "phone",
          value,
          selector: 'a[href^="tel:"]',
        });
      }
    }
  });
  return contacts.filter(
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
): Array<{ kind: "email" | "phone"; value: string; selector: string }> {
  const $ = cheerio.load(html);
  const title = compactText($("title").first().text() || $("h1").first().text());
  return publicContactValues($, PAGE_LOST_PATTERN.test(title));
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
  shardIndex?: number;
  shardCount?: number;
  renderDynamic?: boolean;
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
    .filter((_, index) => index % shardCount === shardIndex)
    .slice(
    0,
    options.domainLimit ?? Number.POSITIVE_INFINITY
    );
  const candidates: ChannelCandidate[] = [];
  const failures: CandidateFile["failures"] = [];
  const candidateKeys = new Set<string>();
  const robotsCache = new Map<string, RobotsPolicy>();

  const getRobots = async (url: URL): Promise<RobotsPolicy> => {
    const cached = robotsCache.get(url.origin);
    if (cached) return cached;
    const robotsUrl = new URL("/robots.txt", url.origin).toString();
    try {
      const response = await safeFetchText(robotsUrl, {
        maxBytes: 512_000,
        accept: "text/plain",
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
    const ownerScopeKey = [
      ...[...group.operatorIds].map((id) => `operator:${id}`),
      ...[...group.venueIds].sort().map((id) => `venue:${id}`),
    ].join("|");
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

    const seedRobots = await getRobots(seedOrigin);
    for (const sitemapUrl of seedRobots.getSitemaps().slice(0, 3)) {
      try {
        const sitemapResponse = await safeFetchText(sitemapUrl, {
          maxBytes: 2_000_000,
          accept: "application/xml,text/xml,text/plain",
        });
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
            return sameSiteHost(seedOrigin, parsed) && linkPriority(url, "") > 0;
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
      queue.sort((left, right) => right.priority - left.priority || left.depth - right.depth);
      const entry = queue.shift();
      if (!entry || seen.has(entry.url)) continue;
      seen.add(entry.url);
      let entryUrl: URL;
      try {
        entryUrl = new URL(entry.url);
      } catch {
        continue;
      }
      const policy = await getRobots(entryUrl);
      if (policy.isAllowed(entry.url, ROBOT_NAME) === false) continue;

      try {
        await sleep(options.delayMs ?? 900);
        const response = await safeFetchText(entry.url);
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
          `${finalUrl} ${title} ${bodyText.slice(0, 12_000)}`
        );
        const pageLooksRelevant =
          pageHasLostEvidence ||
          (CONTACT_PAGE_PATTERN.test(`${finalUrl} ${title}`) &&
            (forms.length > 0 || options.renderDynamic));

        if (pageLooksRelevant) {
          const contactPage = CONTACT_PAGE_PATTERN.test(`${finalUrl} ${title}`);
          const isRelevantForm = (form: (typeof forms)[number]): boolean => {
            const semanticKeys = new Set<string>(
              form.fields.map((field) => field.semanticKey)
            );
            const lostSpecificFields = [
              "lossDate",
              "lossTime",
              "lossLocation",
              "itemCategory",
              "itemDescription",
            ].filter((key) => semanticKeys.has(key)).length;
            const looksLikeGeneralContact =
              contactPage &&
              form.fields.length >= 2 &&
              form.fields.some(
                (field) =>
                  field.semanticKey === "email" ||
                  field.semanticKey === "phone" ||
                  field.semanticKey === "fullName"
              ) &&
              form.fields.some((field) => field.control === "textarea") &&
              !/newsletter|search|suche|site search/i.test(
                `${form.contextText} ${form.formAction ?? ""}`
              );
            return (
              PAGE_LOST_PATTERN.test(form.contextText) ||
              lostSpecificFields >= 2 ||
              looksLikeGeneralContact
            );
          };
          let relevantForms = forms.filter(isRelevantForm);
          if (options.renderDynamic && relevantForms.length === 0) {
            try {
              const rendered = await extractRenderedForms(finalUrl, {
                explore: true,
                maxStates: 8,
              });
              relevantForms = rendered.forms.filter(isRelevantForm);
            } catch {
              // The static page remains a reviewable lead if browser rendering is unavailable.
            }
          }
          const pageForms = relevantForms.length
            ? relevantForms
            : pageHasLostEvidence
              ? [undefined]
              : [];
          for (const form of pageForms) {
            const candidatePageUrl = form?.pageUrl ?? finalUrl;
            const scored = scoreCandidate({
              url: candidatePageUrl,
              title,
              text: bodyText,
              form,
              linkedFromOfficialSeed: true,
            });
            const key = `${ownerScopeKey}|${candidatePageUrl}|${
              form?.contentHash ?? "page"
            }`;
            if (candidateKeys.has(key)) continue;
            candidateKeys.add(key);
            const observedAt = new Date().toISOString();
            candidates.push({
              id: stableId("channel", key),
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
            for (const contact of publicContactValues(
              $,
              PAGE_LOST_PATTERN.test(`${finalUrl} ${title}`)
            )) {
              const contactKey = `${ownerScopeKey}|${contact.kind}|${contact.value.toLowerCase()}`;
              if (candidateKeys.has(contactKey)) continue;
              candidateKeys.add(contactKey);
              const observedAt = new Date().toISOString();
              candidates.push({
                id: stableId("channel", contactKey),
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
                    excerpt: bodyText.slice(0, 500),
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
          if (!["http:", "https:"].includes(target.protocol) || SKIP_PATTERN.test(target.pathname)) {
            return;
          }
          const url = canonicalUrl(target.toString());
          const priority = linkPriority(url, label);
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
        if (entry.depth === 0) {
          failures.push({
            seedUrl: entry.url,
            venueIds: [...group.venueIds].sort(),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  candidates.sort(
    (left, right) =>
      right.confidence - left.confidence ||
      left.pageUrl.localeCompare(right.pageUrl)
  );
  const output: CandidateFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    candidates,
    failures,
  };
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}
