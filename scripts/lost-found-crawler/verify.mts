import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isChannelReviewCurrent,
  type PublishedChannelRegistry,
} from "../../lib/lost-found-channel-schema";
import { extractRenderedForms } from "./browser.mjs";
import { extractFormsFromHtml } from "./form-extractor.mjs";
import {
  pageEvidenceFromHtml,
  pageEvidenceHash,
} from "./page-evidence.mjs";
import { safeFetchText } from "./safe-fetch.mjs";

export interface VerificationReport {
  generatedAt: string;
  results: Array<{
    channelId: string;
    pageUrl: string;
    status:
      | "unchanged"
      | "changed"
      | "gone"
      | "blocked"
      | "retrying"
      | "redirected"
      | "review_due";
    httpStatus?: number;
    finalUrl?: string;
    previousHash: string;
    currentHash?: string;
    method?: "static_form" | "rendered_form" | "page_evidence";
    consecutiveFailures?: number;
    error?: string;
  }>;
}

interface VerificationState {
  version: 1;
  updatedAt: string;
  channels: Record<
    string,
    {
      consecutiveFailures: number;
      lastStatus: VerificationReport["results"][number]["status"];
      lastCheckedAt: string;
      lastSuccessfulAt?: string;
    }
  >;
}

function normalizedVerificationUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

export function isUnexpectedVerificationRedirect(
  expectedUrl: string,
  finalUrl: string
): boolean {
  return normalizedVerificationUrl(expectedUrl) !== normalizedVerificationUrl(finalUrl);
}

async function fetchForVerification(url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await safeFetchText(url);
      if (
        attempt < 2 &&
        (response.status === 429 || response.status >= 500)
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, 250 * 2 ** attempt)
        );
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) =>
          setTimeout(resolve, 250 * 2 ** attempt)
        );
      }
    }
  }
  throw lastError;
}

export async function verifyPublishedChannels(options: {
  registryPath: string;
  outputPath: string;
  statePath?: string;
  renderDynamic?: boolean;
}): Promise<VerificationReport> {
  const registry = JSON.parse(
    await readFile(options.registryPath, "utf8")
  ) as PublishedChannelRegistry;
  const results: VerificationReport["results"] = [];
  let previousState: VerificationState = {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    channels: {},
  };
  if (options.statePath) {
    try {
      const parsed = JSON.parse(
        await readFile(options.statePath, "utf8")
      ) as VerificationState;
      if (parsed.version === 1 && parsed.channels) previousState = parsed;
    } catch {
      // A missing or corrupt cache starts a fresh failure streak.
    }
  }
  for (const channel of registry.channels) {
    try {
      const response = await fetchForVerification(channel.pageUrl);
      if (response.status === 404 || response.status === 410) {
        results.push({
          channelId: channel.id,
          pageUrl: channel.pageUrl,
          status: "gone",
          httpStatus: response.status,
          previousHash: channel.contentHash,
        });
        continue;
      }
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        results.push({
          channelId: channel.id,
          pageUrl: channel.pageUrl,
          status: "blocked",
          httpStatus: response.status,
          previousHash: channel.contentHash,
        });
        continue;
      }
      if (response.status >= 500) {
        results.push({
          channelId: channel.id,
          pageUrl: channel.pageUrl,
          status: "blocked",
          httpStatus: response.status,
          previousHash: channel.contentHash,
          error: `Official server returned HTTP ${response.status} after retries`,
        });
        continue;
      }
      if (isUnexpectedVerificationRedirect(channel.pageUrl, response.url)) {
        results.push({
          channelId: channel.id,
          pageUrl: channel.pageUrl,
          finalUrl: response.url,
          status: "redirected",
          httpStatus: response.status,
          previousHash: channel.contentHash,
        });
        continue;
      }
      const expectsForm =
        Boolean(channel.formAction) ||
        channel.fields.length > 0 ||
        channel.kind === "dedicated_lost_found_form" ||
        channel.kind === "operator_lost_found_form" ||
        channel.kind === "general_contact_form";
      let method: VerificationReport["results"][number]["method"];
      let currentHash: string | undefined;
      if (expectsForm) {
        let forms = extractFormsFromHtml({
          html: response.body,
          pageUrl: response.url,
        });
        let matchingForm =
          forms.find((form) => form.formAction === channel.formAction) ??
          forms.find((form) => form.contentHash === channel.contentHash) ??
          forms[0];
        method = "static_form";
        if (
          options.renderDynamic &&
          (!matchingForm || matchingForm.contentHash !== channel.contentHash)
        ) {
          const rendered = await extractRenderedForms(channel.pageUrl, {
            explore: true,
            maxStates: 8,
          });
          forms = rendered.forms;
          matchingForm =
            forms.find((form) => form.formAction === channel.formAction) ??
            forms.find((form) => form.contentHash === channel.contentHash) ??
            forms[0];
          method = "rendered_form";
        }
        currentHash = matchingForm?.contentHash;
      } else {
        currentHash = pageEvidenceHash(pageEvidenceFromHtml(response.body));
        method = "page_evidence";
      }
      const contentUnchanged = currentHash === channel.contentHash;
      results.push({
        channelId: channel.id,
        pageUrl: channel.pageUrl,
        status: !contentUnchanged
          ? "changed"
          : isChannelReviewCurrent(channel)
            ? "unchanged"
            : "review_due",
        httpStatus: response.status,
        previousHash: channel.contentHash,
        currentHash,
        method,
      });
    } catch (error) {
      results.push({
        channelId: channel.id,
        pageUrl: channel.pageUrl,
        status: "blocked",
        previousHash: channel.contentHash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const report: VerificationReport = {
    generatedAt: new Date().toISOString(),
    results,
  };
  const nextState: VerificationState = {
    version: 1,
    updatedAt: report.generatedAt,
    channels: {},
  };
  const failureStatuses = new Set<
    VerificationReport["results"][number]["status"]
  >(["changed", "gone", "blocked", "retrying", "redirected"]);
  for (const result of report.results) {
    const previous = previousState.channels[result.channelId];
    const failed = failureStatuses.has(result.status);
    const consecutiveFailures = failed
      ? (previous?.consecutiveFailures ?? 0) + 1
      : 0;
    if (result.status === "blocked" && consecutiveFailures < 3) {
      result.status = "retrying";
    }
    result.consecutiveFailures = consecutiveFailures;
    nextState.channels[result.channelId] = {
      consecutiveFailures,
      lastStatus: result.status,
      lastCheckedAt: report.generatedAt,
      lastSuccessfulAt: failed
        ? previous?.lastSuccessfulAt
        : report.generatedAt,
    };
  }
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  if (options.statePath) {
    await mkdir(dirname(options.statePath), { recursive: true });
    await writeFile(
      options.statePath,
      `${JSON.stringify(nextState, null, 2)}\n`
    );
  }
  return report;
}
