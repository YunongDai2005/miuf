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
  const body = $("body").clone();
  body.find("nav, header, footer, aside, script, style, noscript").remove();
  const bodyTextLength = compactText(body.text()).length;
  const candidates = $("main, article, [role='main']").toArray();
  const preferred = candidates
    .map((node) => {
      const clone = $(node).clone();
      clone.find("nav, header, footer, aside, script, style, noscript").remove();
      return { node, textLength: compactText(clone.text()).length };
    })
    .sort((left, right) => right.textLength - left.textLength)[0];
  const root =
    preferred && preferred.textLength >= bodyTextLength * 0.25
      ? $(preferred.node).clone()
      : body;
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
