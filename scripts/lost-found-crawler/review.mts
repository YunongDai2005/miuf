import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { candidateReviewVersion } from "../../lib/channel-review";
import type { ChannelKind } from "../../lib/lost-found-channel-schema";
import type {
  CandidateFile,
  InventoryFile,
  ReviewDecision,
  ReviewFile,
} from "./schemas";

const CHANNEL_KINDS = new Set<ChannelKind>([
  "dedicated_lost_found_form",
  "operator_lost_found_form",
  "general_contact_form",
  "email",
  "phone",
  "central_office_fallback",
]);

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function recordReviewDecision(options: {
  candidatePath: string;
  reviewPath: string;
  candidateId: string;
  decision: "accept" | "reject";
  reviewedBy: string;
  reviewedAt?: string;
  notes?: string;
  kindOverride?: string;
  venueIdsOverride?: string[];
  submissionMode?: string;
  adapterId?: string;
}): Promise<ReviewDecision> {
  if (!options.reviewedBy.trim()) throw new Error("--reviewer is required");
  const candidateFile = JSON.parse(
    await readFile(options.candidatePath, "utf8")
  ) as CandidateFile;
  const candidate = candidateFile.candidates.find(
    (entry) => entry.id === options.candidateId
  );
  if (!candidate) throw new Error(`Unknown candidate ${options.candidateId}`);
  const reviewFile = JSON.parse(
    await readFile(options.reviewPath, "utf8")
  ) as ReviewFile;
  if (options.kindOverride && !CHANNEL_KINDS.has(options.kindOverride as ChannelKind)) {
    throw new Error(`Unsupported channel kind ${options.kindOverride}`);
  }
  if (
    options.submissionMode &&
    options.submissionMode !== "open_only" &&
    options.submissionMode !== "assisted_fill" &&
    options.submissionMode !== "adapter"
  ) {
    throw new Error("Review selected an unsupported submission mode");
  }
  if (options.submissionMode === "adapter" && !options.adapterId) {
    throw new Error("Adapter submission mode requires --adapter=...");
  }
  if (
    options.decision === "accept" &&
    (candidate.canonicalizationStatus === "pending" ||
      candidate.venueIds.length === 0) &&
    !options.venueIdsOverride?.length
  ) {
    throw new Error(
      "Pending Google candidates require --venues=<open venue id> before acceptance"
    );
  }
  const decision: ReviewDecision = {
    candidateId: options.candidateId,
    decision: options.decision,
    reviewedAt: options.reviewedAt ?? new Date().toISOString(),
    reviewedBy: options.reviewedBy.trim(),
    // This command is the manual path; the automated audit records "automated".
    reviewerKind: "human",
    reviewedCandidateVersion: candidateReviewVersion(candidate),
    notes: options.notes?.trim() || undefined,
    kindOverride: options.kindOverride as ChannelKind | undefined,
    venueIdsOverride: options.venueIdsOverride,
    submissionMode: options.submissionMode as
      | "open_only"
      | "assisted_fill"
      | "adapter"
      | undefined,
    adapterId: options.adapterId?.trim() || undefined,
    reviewedContentHash:
      options.submissionMode === "assisted_fill" ||
      options.submissionMode === "adapter"
        ? candidate.form?.contentHash
        : undefined,
  };
  if (
    (options.submissionMode === "assisted_fill" ||
      options.submissionMode === "adapter") &&
    !decision.reviewedContentHash
  ) {
    throw new Error(
      "Assisted filling requires a currently extracted form to review"
    );
  }
  reviewFile.decisions = [
    ...reviewFile.decisions.filter(
      (entry) => entry.candidateId !== options.candidateId
    ),
    decision,
  ];
  await writeFile(options.reviewPath, `${JSON.stringify(reviewFile, null, 2)}\n`);
  return decision;
}

export async function exportReviewReport(options: {
  candidatePath: string;
  reviewPath: string;
  inventoryPath?: string;
  outputPath: string;
}): Promise<number> {
  const candidates = JSON.parse(
    await readFile(options.candidatePath, "utf8")
  ) as CandidateFile;
  const reviews = JSON.parse(
    await readFile(options.reviewPath, "utf8")
  ) as ReviewFile;
  let inventory: InventoryFile | undefined;
  if (options.inventoryPath) {
    try {
      inventory = JSON.parse(
        await readFile(options.inventoryPath, "utf8")
      ) as InventoryFile;
    } catch {
      // The report remains usable with ids if an inventory artifact is absent.
    }
  }
  const venues = new Map(
    inventory?.venues.map((venue) => [venue.venueId, venue]) ?? []
  );
  const operators = new Map(
    inventory?.operators.map((operator) => [operator.id, operator]) ?? []
  );
  const decisions = new Map(
    reviews.decisions.map((decision) => [decision.candidateId, decision])
  );
  const cards = candidates.candidates
    .map((candidate) => {
      const decision = decisions.get(candidate.id);
      const fields = candidate.form?.fields
        .filter((field) => field.control !== "hidden")
        .map(
          (field) => `
            <tr>
              <td>${escapeHtml(field.label)}</td>
              <td>${escapeHtml(field.semanticKey)}</td>
              <td>${field.required ? "yes" : "no"}</td>
              <td>${Math.round(field.semanticConfidence * 100)}%</td>
            </tr>`
        )
        .join("");
      const path = candidate.discoveryPath
        .map(
          (step) =>
            `<a href="${escapeHtml(step.url)}">${escapeHtml(step.label)}</a>`
        )
        .join(" → ");
      const venueLabels = candidate.venueIds.map((venueId) => {
        const venue = venues.get(venueId);
        return venue
          ? `${escapeHtml(venue.venueName)} <span class="id">(${escapeHtml(
              venueId
            )})</span>`
          : escapeHtml(venueId);
      });
      const operator = candidate.operatorId
        ? operators.get(candidate.operatorId)
        : undefined;
      const acceptCommand =
        candidate.kind === "manual_review"
          ? "No safe accept shortcut: this is evidence only. Accept a separately extracted form, email or phone candidate; otherwise reject this lead."
          : candidate.canonicalizationStatus === "pending"
            ? `Map this Place ID to OSM/Wikidata first, then add --venues=&lt;open venue id&gt;: npm run data:lost-found:review -- --candidate=${candidate.id} --decision=accept --reviewer=&quot;YOUR NAME&quot; --kind=${candidate.kind} --submission-mode=open_only --venues=&lt;open venue id&gt;`
          : `npm run data:lost-found:review -- --candidate=${candidate.id} --decision=accept --reviewer=&quot;YOUR NAME&quot; --kind=${candidate.kind} --submission-mode=open_only`;
      const rejectCommand = `npm run data:lost-found:review -- --candidate=${candidate.id} --decision=reject --reviewer=&quot;YOUR NAME&quot; --notes=&quot;REASON&quot;`;
      return `
        <article>
          <header>
            <div>
              <h2>${escapeHtml(candidate.kind)}</h2>
              <p class="id">${escapeHtml(candidate.id)}</p>
            </div>
            <strong>${candidate.confidence}/100</strong>
          </header>
          <p><a href="${escapeHtml(candidate.pageUrl)}">${escapeHtml(candidate.pageUrl)}</a></p>
          ${
            candidate.contactValue
              ? `<p><b>Contact value:</b> ${escapeHtml(
                  candidate.contactValue
                )}</p>`
              : ""
          }
          <p><b>Venues:</b> ${venueLabels.join(", ")}</p>
          ${
            candidate.sourcePlaceIds?.length
              ? `<p><b>Google source Place IDs:</b> ${candidate.sourcePlaceIds
                  .map(escapeHtml)
                  .join(", ")} (${escapeHtml(
                  candidate.canonicalizationStatus ?? "mapped"
                )})</p>`
              : ""
          }
          ${
            candidate.operatorId
              ? `<p><b>Operator:</b> ${escapeHtml(
                  operator?.name ?? candidate.operatorId
                )} <span class="id">(${escapeHtml(
                  candidate.operatorId
                )})</span></p>`
              : ""
          }
          <p><b>Path:</b> ${path}</p>
          <p><b>Reasons:</b> ${candidate.reasons.map(escapeHtml).join("; ")}</p>
          <p><b>Current review:</b> ${escapeHtml(decision?.decision ?? "not reviewed")}
          ${decision ? `by ${escapeHtml(decision.reviewedBy)}` : ""}</p>
          ${
            fields
              ? `<table><thead><tr><th>Field</th><th>Meaning</th><th>Required</th><th>Confidence</th></tr></thead><tbody>${fields}</tbody></table>`
              : "<p>No lost-property form fields were confirmed on this page.</p>"
          }
          <details><summary>Evidence excerpt</summary><pre>${escapeHtml(
            candidate.evidence[0]?.excerpt
          )}</pre></details>
          <details><summary>Review commands</summary>
            <p>Accepting a destination does not enable assisted filling. Select
            <code>assisted_fill</code> only after checking every field mapping.</p>
            <pre>${acceptCommand}</pre><pre>${rejectCommand}</pre>
          </details>
        </article>`;
    })
    .join("");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Lost-property channel review</title>
<style>
body{font:14px/1.5 system-ui;margin:0;background:#f5f5f4;color:#292524}
main{max-width:1000px;margin:auto;padding:32px 20px}h1{margin-bottom:4px}article{background:white;border:1px solid #e7e5e4;border-radius:16px;padding:20px;margin:18px 0}
header{display:flex;justify-content:space-between;gap:16px}h2{margin:0}.id{color:#78716c;margin:2px 0}a{color:#c2410c;word-break:break-all}
table{border-collapse:collapse;width:100%;margin-top:12px}th,td{text-align:left;border-bottom:1px solid #e7e5e4;padding:7px}pre{white-space:pre-wrap;overflow-wrap:anywhere}.id{font-size:12px;color:#78716c}code{background:#f5f5f4;padding:2px 4px;border-radius:4px}
</style></head><body><main><h1>Lost-property channel review</h1>
<p>Generated ${escapeHtml(candidates.generatedAt)} · ${candidates.candidates.length} candidates. This report is read-only; record decisions with the review command.</p>
${cards || "<p>No candidates found.</p>"}</main></body></html>`;
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, html);
  return candidates.candidates.length;
}
