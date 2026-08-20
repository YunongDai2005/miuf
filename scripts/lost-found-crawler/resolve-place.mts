/**
 * Resolves one venue's official website to a lost-property route.
 *
 * The second stage of the two-stage design: a place directory supplies a
 * website and a telephone number, and this decides which page on that website —
 * if any — is the one to send a traveller to.
 *
 * Three orderings are tried, cheapest first, because they fail on different
 * sites. A sitemap names every page in one request and found Tempodrom's
 * /besucherinfos/fundsachen/, a path no guess would produce; guessing common
 * paths reaches Huxleys, whose sitemap holds 2,197 entries; and a shallow crawl
 * of the pages a visitor would click is what finds Zoo Berlin's, which lives
 * inside an ordinary /faq page under the heading "Wo werden Fundsachen
 * gesammelt?" with nothing in the URL to suggest it.
 *
 * A run that finds nothing reports that the system did not find a page, not
 * that none exists: a bounded crawl cannot prove absence.
 */
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { safeFetchText } from "./safe-fetch.mjs";
import { extractPublicContactValues } from "./discovery.mjs";

const LOST_TERMS = [
  /lost\s*(?:and|&)\s*found/i,
  /lostandfound/i,
  /lost[-\s]?property/i,
  /lost item/i,
  /fundb(?:ü|ue)ro/i,
  /fundsachen?/i,
  /fundservice/i,
  /fundgegenst(?:ä|ae)nde/i,
  /verlustmeldung/i,
  /etwas verloren/i,
  /verlorene gegenst(?:ä|ae)nde/i,
  /gegenstand verloren/i,
];

const ACTION_TERMS = [
  /abholen/i, /melden/i, /kontakt/i, /servicecenter/i, /service ?center/i,
  /claim/i, /report/i, /collect/i, /enquir/i, /wenden sie sich/i,
];

/** Paths a venue is likely to publish a lost-property page under. */
const GUESSES = [
  "/lostandfound", "/lost-and-found", "/lost-property",
  "/fundsachen", "/fundbuero", "/fundbüro", "/fundservice",
  "/service/fundsachen", "/service/fundbuero", "/besucherinfos/fundsachen",
  "/besuch/fundsachen", "/en/lost-and-found", "/en/lost-property",
  // German sites commonly carry a language prefix: Olympiastadion publishes at
  // /de/fundsachen/, which none of the unprefixed guesses reaches.
  "/de/fundsachen/", "/de/fundbuero/", "/de/lost-and-found/", "/en/fundsachen/",
];

/**
 * Link text that leads towards visitor information. Guessing paths fails on
 * German sites, which nest them: the Staatsoper answers at /de/extra/faq/,
 * Velodrom at /besuch/faq and Berghain at /de/contact/. Following the links a
 * visitor would click reaches all three; a fixed list reached none.
 */
const SERVICE_HINT =
  /faq|h(?:ä|ae)ufige|fragen|service|besuch|visit|info|kontakt|contact|hilfe|help|besucher|haus(?:ordnung)?|regel/i;

export type ResolutionStatus = "PAGE_FOUND" | "PHONE_FALLBACK" | "MANUAL_REVIEW";

export interface PlaceResolution {
  placeName?: string;
  website: string;
  status: ResolutionStatus;
  lostFoundUrl?: string;
  /** Where on the page the evidence was found, quoted from the source. */
  evidence?: string;
  contactValues?: Array<{ kind: "email" | "phone"; value: string }>;
  phone?: string;
  confidence?: number;
  pagesRead: number;
  discoveredVia?: "sitemap" | "guessed-path" | "shallow-crawl" | "navigation-link";
  checkedAt: string;
}

/**
 * Whether a lost-property phrase is accompanied, close by, with a way to act on
 * it. A page that says "Fundsachen" and then gives an address is answering the
 * question; a concert listing for a band called Lost & Found matches the same
 * words and answers nothing. Requiring the two to appear together separates
 * them without needing to enumerate band names.
 */
function actionableMention(text: string): boolean {
  const reachable = /@|\btel\b|telefon|phone|\+\d{2}|\d{3}[\s/-]?\d{4}/i;
  for (const term of LOST_TERMS) {
    // Every occurrence, not the first. On a page devoted to lost property the
    // first mention is usually the navigation entry that links to it, sitting
    // in a run of menu labels with nothing actionable nearby; the paragraph
    // that answers the question comes later. Testing only the first match
    // scored Olympiastadion's own Fundsachen page at zero.
    const scan = new RegExp(term.source, `${term.flags.replace("g", "")}g`);
    for (let match = scan.exec(text); match; match = scan.exec(text)) {
      const window = text.slice(
        Math.max(0, match.index - 200),
        match.index + match[0].length + 400
      );
      if (ACTION_TERMS.some((action) => action.test(window)) || reachable.test(window)) {
        return true;
      }
    }
  }
  return false;
}

export function scorePage(url: string, title: string, text: string): number {
  let score = 0;
  if (LOST_TERMS.some((term) => term.test(url))) score += 5;
  if (LOST_TERMS.some((term) => term.test(title))) score += 6;
  if (LOST_TERMS.some((term) => term.test(text))) score += 4;
  if (ACTION_TERMS.some((term) => term.test(text))) score += 2;
  // Without a nearby way to act the mention is incidental, whatever it scored.
  if (score > 0 && !actionableMention(`${title} ${text}`)) return 0;
  return score;
}

/**
 * The sentence a reader would be shown as proof. A menu that lists "Lost &
 * Found" among its items matches the same terms as the paragraph that explains
 * what to do, so the one carrying a way to act is preferred and run-on
 * navigation text is skipped.
 */
function evidenceSentence(text: string): string | undefined {
  const candidates = text
    .split(/(?<=[.!?:])\s+|\n/)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        sentence.length >= 20 &&
        sentence.length <= 400 &&
        LOST_TERMS.some((term) => term.test(sentence))
    );
  // Menus arrive as one run of concatenated labels — "GalerieLost & FoundHotels"
  // — because the markup separates them but the text does not. A genuine
  // sentence has spaces where a menu has case changes.
  const isNavigation = (sentence: string): boolean => {
    if (/überspringen|zum inhalt springen|skip to (?:main )?content/i.test(sentence)) return true;
    const joins = (sentence.match(/[a-zäöüß][A-ZÄÖÜ]/g) ?? []).length;
    return joins >= 3;
  };
  const actionable = candidates.find(
    (sentence) =>
      !isNavigation(sentence) &&
      (ACTION_TERMS.some((term) => term.test(sentence)) ||
        /@|telefon|\+\d{2}/i.test(sentence))
  );
  return actionable ?? candidates.find((sentence) => !isNavigation(sentence));
}

interface PageRead {
  url: string;
  title: string;
  text: string;
  html: string;
  score: number;
  /** Same-site links whose href or anchor text names lost property. */
  lostLinks: string[];
  /** Same-site links towards visitor information, followed when nothing better remains. */
  serviceLinks: string[];
}

const ROBOT_NAME = "Berlin-Lost-Found-Channel-Research";
const robotsCache = new Map<string, ReturnType<typeof robotsParser> | null>();

/** RFC 9309. A disallowed path is not fetched, whichever stage proposed it. */
async function robotsAllows(url: string): Promise<boolean> {
  const origin = new URL(url).origin;
  if (!robotsCache.has(origin)) {
    try {
      const response = await safeFetchText(`${origin}/robots.txt`, { timeoutMs: 10_000 });
      robotsCache.set(
        origin,
        response.status >= 200 && response.status < 300
          ? robotsParser(`${origin}/robots.txt`, response.body)
          : null
      );
    } catch {
      robotsCache.set(origin, null);
    }
  }
  const policy = robotsCache.get(origin);
  // No usable robots.txt means no stated preference, so the fetch may proceed.
  return policy ? policy.isAllowed(url, ROBOT_NAME) !== false : true;
}

const INTERSTITIAL = /captcha|are you a (?:human|robot)|请证明|bot detection|perfdrive|cloudflare|access denied|checking your browser/i;

async function readPage(url: string, expectedOrigin?: string): Promise<PageRead | undefined> {
  try {
    if (!(await robotsAllows(url))) return undefined;
    const response = await safeFetchText(url, { timeoutMs: 12_000 });
    if (response.status < 200 || response.status >= 300) return undefined;
    if (!/text\/html/i.test(response.headers.get("content-type") ?? "")) return undefined;
    // A bot check served in place of the page is not the venue speaking, and
    // one such interstitial matched on the word it uses to describe itself.
    // A site that redirects www to its apex, as the Deutsche Oper does, is not
    // sending the crawler elsewhere. Compare the registrable name, not the host.
    const sameSite = (left: string, right: string): boolean => {
      const name = (value: string) =>
        new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
      return name(left) === name(right);
    };
    if (expectedOrigin && !sameSite(response.url, expectedOrigin)) return undefined;
    if (INTERSTITIAL.test(response.body.slice(0, 4_000))) return undefined;
    const $ = cheerio.load(response.body);
    $("script, style, noscript").remove();
    // FAQ answers are commonly reached through a disclosure widget, so the
    // question is in a <summary> or an accordion button rather than a heading.
    const title = [
      $("title").first().text(),
      $("h1, h2, h3, h4").map((_, node) => $(node).text()).get().join(" "),
      $("summary, dt, [class*='accordion'], [role='button']")
        .map((_, node) => $(node).text())
        .get()
        .join(" "),
    ].join(" ").replace(/\s+/g, " ").trim();
    // cheerio concatenates without separators, so block elements run together:
    // Berghain's answer arrived as "…berghain.deLost & FoundBitte sende…". That
    // reads as menu noise to any heuristic and hides real sentences, so the
    // boundaries are restored before the text is taken.
    $("br, p, div, li, td, th, section, article, h1, h2, h3, h4, h5, h6, a, span")
      .after(" ");
    const text = $("body").text().replace(/\s+/g, " ").trim();
    const linkText = $("a").map((_, node) => $(node).text()).get().join(" ");
    // Columbiahalle publishes its page at /lost-found.html and names it only in
    // the navigation: not in the sitemap, and not a path worth guessing. The
    // anchor text is the signal that no list of paths can replace.
    const origin = new URL(response.url).origin;
    const lostLinks: string[] = [];
    const serviceLinks: string[] = [];
    $("a[href]").each((_, node) => {
      const href = ($(node).attr("href") ?? "").trim();
      const label = $(node).text().replace(/\s+/g, " ").trim();
      if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;
      let resolved: URL;
      try {
        resolved = new URL(href, response.url);
      } catch {
        return;
      }
      if (resolved.origin !== origin) return;
      resolved.hash = "";
      const target = `${resolved.pathname} ${label}`;
      if (LOST_TERMS.some((term) => term.test(target))) {
        lostLinks.push(resolved.toString());
      } else if (SERVICE_HINT.test(target)) {
        serviceLinks.push(resolved.toString());
      }
    });
    return {
      url: response.url,
      title,
      text,
      html: response.body,
      score: scorePage(response.url, `${title} ${linkText}`, text),
      lostLinks: [...new Set(lostLinks)],
      serviceLinks: [...new Set(serviceLinks)],
    };
  } catch {
    return undefined;
  }
}

async function sitemapUrls(origin: string): Promise<string[]> {
  const collected: string[] = [];
  const seeds: string[] = [];
  try {
    const robots = await safeFetchText(`${origin}/robots.txt`, { timeoutMs: 10_000 });
    if (robots.status >= 200 && robots.status < 300) {
      const policy = robotsParser(`${origin}/robots.txt`, robots.body);
      seeds.push(...policy.getSitemaps());
    }
  } catch {
    // A missing robots.txt is not an error; fall back to the usual location.
  }
  if (!seeds.length) seeds.push(`${origin}/sitemap.xml`);

  for (const seed of seeds.slice(0, 3)) {
    try {
      const response = await safeFetchText(seed, { timeoutMs: 12_000 });
      if (response.status < 200 || response.status >= 300) continue;
      const locations = [...response.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      const isIndex = locations.length > 0 && locations.every((l) => /\.xml(?:\.gz)?$/i.test(l));
      if (!isIndex) {
        collected.push(...locations);
        continue;
      }
      for (const child of locations.slice(0, 8)) {
        try {
          const nested = await safeFetchText(child, { timeoutMs: 12_000 });
          if (nested.status >= 200 && nested.status < 300) {
            collected.push(...[...nested.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
          }
        } catch {
          // one unreadable child sitemap does not invalidate the rest
        }
      }
    } catch {
      // try the next declared sitemap
    }
  }
  return collected;
}

export async function resolveLostAndFound(input: {
  website: string;
  placeName?: string;
  phone?: string;
  maxPages?: number;
  minScore?: number;
}): Promise<PlaceResolution> {
  const maxPages = input.maxPages ?? 30;
  // Eight admitted only pages devoted to lost property. The Staatsoper answers
  // the question inside a general FAQ, which scores six: text and an action but
  // nothing in the URL or a heading. Six is the floor because the checks that
  // follow — a quotable sentence, a contact near the phrase, no interstitial —
  // are what reject a page, not the score alone.
  const minScore = input.minScore ?? 6;
  const checkedAt = new Date().toISOString();
  const origin = new URL(input.website).origin;
  const seen = new Set<string>();
  let pagesRead = 0;
  let best: { page: PageRead; via: PlaceResolution["discoveredVia"] } | undefined;

  const followUp: string[] = [];
  const service: string[] = [];
  // The condition that stops the search must be the condition that accepts a
  // result. They drifted apart: a page scoring six ended the crawl, then failed
  // the evidence check, and the venue was reported as having nothing while
  // pages it had not yet looked at still held the answer.
  const accepts = (page: PageRead): boolean =>
    page.score >= minScore &&
    Boolean(evidenceSentence(page.text) || LOST_TERMS.some((t) => t.test(page.url)));
  // A guessed path is usually a 404 and costs a request, not a page of reading.
  // Charging them to the same budget left Berghain and Velodrom unreached: the
  // seventeen guesses spent most of it before the crawl had started.
  let guessesTried = 0;
  const consider = async (
    url: string,
    via: PlaceResolution["discoveredVia"]
  ): Promise<boolean> => {
    if (via === "guessed-path" ? guessesTried >= 20 : pagesRead >= maxPages) return false;
    const canonical = url.split("#")[0];
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    const page = await readPage(canonical, origin);
    if (via === "guessed-path" && !page) guessesTried += 1;
    else pagesRead += 1;
    if (!page) return false;
    followUp.push(...page.lostLinks.filter((link) => !seen.has(link.split("#")[0])));
    service.push(...page.serviceLinks.filter((link) => !seen.has(link.split("#")[0])));
    // A page that satisfies the acceptance test must become the result, even
    // when an earlier page scored the same. Velodrom's contact page and its FAQ
    // both scored twelve; the contact page was read first and kept, so the FAQ
    // that actually answered the question never became the answer.
    const accepted = accepts(page);
    if (!best || accepted || page.score > best.page.score) {
      if (!best || accepted || !accepts(best.page)) best = { page, via };
    }
    return accepted;
  };

  // 1. The sitemap names every page in one or two requests.
  const listed = await sitemapUrls(origin);
  const promising = listed.filter((url) => LOST_TERMS.some((term) => term.test(url)));
  for (const url of promising.slice(0, 5)) {
    if (await consider(url, "sitemap")) break;
  }

  // 2. Common paths, for sites whose sitemap is missing or too large to scan.
  if (!best || !accepts(best.page)) {
    for (const path of GUESSES) {
      if (await consider(`${origin}${path}`, "guessed-path")) break;
    }
  }

  // 3. The pages a visitor would click, reached by following the site's own
  //    navigation. Zoo Berlin's answer lives in an ordinary FAQ page.
  if (!best || !accepts(best.page)) {
    await consider(origin, "shallow-crawl");
    // Contact and FAQ answer this question far more often than a generic
    // "Information" section, so they are visited before the rest.
    const rank = (url: string): number =>
      /kontakt|contact/i.test(url) ? 0
      : /faq|h(?:ä|ae)ufige|fragen/i.test(url) ? 1
      : /service|besuch|visit|besucher/i.test(url) ? 2
      : 3;
    service.sort((left, right) => rank(left) - rank(right));
    while (service.length && pagesRead < maxPages) {
      if (await consider(service.shift()!, "shallow-crawl")) break;
      // A lost-property link seen on the way takes precedence.
      while (followUp.length && pagesRead < maxPages) {
        if (await consider(followUp.shift()!, "navigation-link")) break;
      }
      if (best && accepts(best.page)) break;
    }
  }

  // 4. Links named after lost property on any page already read. A menu entry
  // is how a site announces the page when neither its sitemap nor its URL does.
  if (!best || !accepts(best.page)) {
    while (followUp.length && pagesRead < maxPages) {
      if (await consider(followUp.shift()!, "navigation-link")) break;
    }
  }

  const evidence = best ? evidenceSentence(best.page.text) : undefined;
  // A URL the site itself named /fundsachen is its own evidence. Otherwise the
  // page must yield a sentence worth showing: three venues passed on a keyword
  // that appeared only in a navigation bar, with nothing to show a traveller.
  if (best && accepts(best.page)) {
    const contacts = extractPublicContactValues(best.page.html)
      .map(({ kind, value }) => ({ kind, value }));
    return {
      placeName: input.placeName,
      website: input.website,
      status: "PAGE_FOUND",
      lostFoundUrl: best.page.url,
      evidence,
      contactValues: contacts.length ? contacts : undefined,
      phone: input.phone,
      confidence: best.page.score,
      pagesRead,
      discoveredVia: best.via,
      checkedAt,
    };
  }

  return {
    placeName: input.placeName,
    website: input.website,
    status: input.phone ? "PHONE_FALLBACK" : "MANUAL_REVIEW",
    phone: input.phone,
    confidence: best?.page.score,
    pagesRead,
    checkedAt,
  };
}
