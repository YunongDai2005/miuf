import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfTextSnapshot {
  title: string;
  bodyText: string;
  pagesRead: number;
  totalPages: number;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Extract bounded, non-rendered text from a public PDF. This is intentionally
 * limited: the crawler only needs enough policy text to find review candidates,
 * not a complete archival copy of the source document.
 */
export async function extractPdfText(
  data: Uint8Array,
  options: {
    maxPages?: number;
    maxCharacters?: number;
  } = {}
): Promise<PdfTextSnapshot> {
  const maxPages = Math.max(1, options.maxPages ?? 40);
  const maxCharacters = Math.max(1_000, options.maxCharacters ?? 200_000);
  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });

  try {
    const document = await loadingTask.promise;
    const pagesRead = Math.min(document.numPages, maxPages);
    const pageTexts: string[] = [];
    let characterCount = 0;

    for (let pageNumber = 1; pageNumber <= pagesRead; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = compactText(
        content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
      );
      if (!pageText) continue;
      const remaining = maxCharacters - characterCount;
      if (remaining <= 0) break;
      pageTexts.push(pageText.slice(0, remaining));
      characterCount += Math.min(pageText.length, remaining);
    }

    const bodyText = compactText(pageTexts.join(" "));
    let title = "";
    try {
      const metadata = await document.getMetadata();
      const info = metadata.info as { Title?: unknown };
      if (typeof info.Title === "string") title = compactText(info.Title);
    } catch {
      // Metadata is optional; visible text remains the source of truth.
    }
    if (!title) title = bodyText.slice(0, 160);

    return {
      title,
      bodyText,
      pagesRead,
      totalPages: document.numPages,
    };
  } finally {
    await loadingTask.destroy();
  }
}
