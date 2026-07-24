import { readFile, writeFile } from "node:fs/promises";
import { extractRenderedForms } from "./browser.mjs";
import { extractFormsFromHtml } from "./form-extractor.mjs";
import {
  pageEvidenceFromHtml,
  pageEvidenceHash,
} from "./page-evidence.mjs";
import { safeFetchText } from "./safe-fetch.mjs";
import { scoreCandidate } from "./scoring.mjs";
import type {
  CandidateFile,
  ChannelCandidate,
  FormSnapshot,
} from "./schemas";

function stableAction(value: string | undefined): string {
  if (!value) return "";
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(cHash|csrf|token|nonce|state|timestamp|_ts)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

export function selectRefreshedForm(
  previous: Pick<
    FormSnapshot,
    "fields" | "formAction" | "contentHash" | "pageUrl"
  >,
  forms: FormSnapshot[]
): FormSnapshot | undefined {
  const oldFields = new Set(
    previous.fields.map((field) => field.rawName).filter(Boolean)
  );
  return forms
    .map((form) => {
      const commonFields = form.fields.filter(
        (field) => field.rawName && oldFields.has(field.rawName)
      ).length;
      const fieldCoverage =
        oldFields.size > 0 ? commonFields / oldFields.size : 0;
      const score =
        Number(form.contentHash === previous.contentHash) * 1_000 +
        Number(
          stableAction(form.formAction) === stableAction(previous.formAction)
        ) *
          100 +
        fieldCoverage * 20 +
        Number(form.pageUrl === previous.pageUrl);
      return { form, score, commonFields };
    })
    .filter((entry) => entry.commonFields > 0)
    .sort((left, right) => right.score - left.score)[0]?.form;
}

function sameDestination(expected: string, actual: string): boolean {
  const left = new URL(expected);
  const right = new URL(actual);
  const path = (value: URL) => value.pathname.replace(/\/+$/, "") || "/";
  return left.origin === right.origin && path(left) === path(right);
}

export async function refreshCandidateForms(options: {
  candidatePath: string;
  candidateIds: string[];
  renderDynamic?: boolean;
}): Promise<ChannelCandidate[]> {
  const file = JSON.parse(
    await readFile(options.candidatePath, "utf8")
  ) as CandidateFile;
  if (file.version !== 1) throw new Error("Unsupported candidate file");

  const requested = new Set(options.candidateIds);
  const candidates = file.candidates.filter((candidate) =>
    requested.has(candidate.id)
  );
  const missing = [...requested].filter(
    (id) => !candidates.some((candidate) => candidate.id === id)
  );
  if (missing.length) {
    throw new Error(`Unknown candidate ids: ${missing.join(", ")}`);
  }
  if (candidates.some((candidate) => !candidate.form)) {
    throw new Error("Only form candidates can be refreshed");
  }

  const refreshed: ChannelCandidate[] = [];
  for (const candidate of candidates) {
    const response = await safeFetchText(candidate.pageUrl);
    if (!sameDestination(candidate.pageUrl, response.url)) {
      throw new Error(
        `Candidate ${candidate.id} redirected to a different destination`
      );
    }
    const pageEvidence = pageEvidenceFromHtml(response.body);
    const forms = options.renderDynamic
      ? (await extractRenderedForms(candidate.pageUrl, {
          explore: true,
          maxStates: 8,
        })).forms
      : extractFormsFromHtml({
          html: response.body,
          pageUrl: response.url,
        });
    const form = selectRefreshedForm(candidate.form as FormSnapshot, forms);
    if (!form) {
      throw new Error(`Could not identify the reviewed form for ${candidate.id}`);
    }
    const scored = scoreCandidate({
      url: candidate.pageUrl,
      title: pageEvidence.title,
      text: pageEvidence.bodyText,
      form,
      linkedFromOfficialSeed: true,
    });
    const observedAt = new Date().toISOString();
    const updated: ChannelCandidate = {
      ...candidate,
      kind: scored.kind,
      form,
      confidence: scored.confidence,
      reasons: scored.reasons,
      evidence: [
        ...candidate.evidence.filter(
          (entry) => entry.sourceUrl !== candidate.pageUrl
        ),
        {
          sourceUrl: candidate.pageUrl,
          excerpt: pageEvidence.bodyText.slice(0, 500),
          contentHash: pageEvidenceHash(pageEvidence, form.contentHash),
          observedAt,
        },
      ],
      fetchStatus: "ok",
    };
    Object.assign(candidate, updated);
    refreshed.push(updated);
  }

  file.generatedAt = new Date().toISOString();
  await writeFile(
    options.candidatePath,
    `${JSON.stringify(file, null, 2)}\n`
  );
  return refreshed;
}
