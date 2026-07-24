import * as cheerio from "cheerio";
import { stableHash } from "./hash.mjs";

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export interface PageEvidenceSnapshot {
  title: string;
  bodyText: string;
}

/**
 * Produce the same stable, navigation-free page representation during
 * discovery and later verification. Menus and footers change often and are
 * also a common source of false lost-property matches.
 */
export function pageEvidenceFromHtml(html: string): PageEvidenceSnapshot {
  const $ = cheerio.load(html);
  const title = compactText($("title").first().text() || $("h1").first().text());
  const preferred = $("main, article, [role='main']").first();
  const root = preferred.length ? preferred.clone() : $("body").clone();
  root.find("nav, header, footer, aside, script, style, noscript").remove();
  return {
    title,
    bodyText: compactText(root.text()),
  };
}

export function pageEvidenceHash(
  snapshot: PageEvidenceSnapshot,
  formHash?: string
): string {
  return stableHash({
    title: snapshot.title,
    body: snapshot.bodyText.slice(0, 20_000),
    formHash,
  });
}
