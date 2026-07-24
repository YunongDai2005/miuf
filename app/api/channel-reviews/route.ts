import candidateData from "../../../data/lost-found-crawler/channels.candidates.json";
import reviewData from "../../../data/lost-found-crawler/reviews.json";
import { getChatGPTUser } from "../../chatgpt-auth";
import {
  appendReviewEvent,
  readCurrentReviewDecisions,
} from "../../../db/channel-reviews";
import {
  createReviewDecision,
  type ReviewWriteInput,
} from "../../../lib/channel-review";
import type {
  CandidateFile,
  ReviewFile,
} from "../../../scripts/lost-found-crawler/schemas";

export const dynamic = "force-dynamic";

const candidates = (candidateData as unknown as CandidateFile).candidates;
const candidatesById = new Map(
  candidates.map((candidate) => [candidate.id, candidate])
);

function noStoreJson(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  return Response.json(value, { ...init, headers });
}

async function requireApiUser() {
  return getChatGPTUser();
}

function isSameOriginWrite(request: Request): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

export async function GET() {
  const user = await requireApiUser();
  if (!user) {
    return noStoreJson({ error: "Sign in is required." }, { status: 401 });
  }
  try {
    const decisions = await readCurrentReviewDecisions(
      candidates,
      (reviewData as unknown as ReviewFile).decisions
    );
    return noStoreJson({
      version: 1,
      generatedAt: (candidateData as unknown as CandidateFile).generatedAt,
      decisions,
    });
  } catch {
    return noStoreJson(
      { error: "The review store is temporarily unavailable." },
      { status: 503 }
    );
  }
}

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) {
    return noStoreJson({ error: "Sign in is required." }, { status: 401 });
  }
  if (!isSameOriginWrite(request)) {
    return noStoreJson(
      { error: "The review request did not come from this site." },
      { status: 403 }
    );
  }
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return noStoreJson(
      { error: "A JSON review request is required." },
      { status: 415 }
    );
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return noStoreJson({ error: "The review note is too large." }, { status: 413 });
  }

  let payload: ReviewWriteInput;
  try {
    payload = (await request.json()) as ReviewWriteInput;
  } catch {
    return noStoreJson({ error: "The review JSON is invalid." }, { status: 400 });
  }
  if (
    !payload ||
    typeof payload.candidateId !== "string" ||
    !["accept", "reject", "clear"].includes(payload.decision)
  ) {
    return noStoreJson(
      { error: "A valid candidate and decision are required." },
      { status: 400 }
    );
  }
  const candidate = candidatesById.get(payload.candidateId);
  if (!candidate) {
    return noStoreJson({ error: "This candidate no longer exists." }, { status: 404 });
  }

  try {
    if (payload.decision === "clear") {
      await appendReviewEvent({
        candidate,
        action: "clear",
        reviewerEmail: user.email,
      });
      return noStoreJson({ decision: null });
    }
    const decision = createReviewDecision({
      candidate,
      decision: payload.decision,
      // The private audit table keeps the authenticated email. Public channel
      // data receives a non-identifying attribution.
      reviewerName: "Authenticated reviewer",
      notes: typeof payload.notes === "string" ? payload.notes : undefined,
      submissionMode: payload.submissionMode,
    });
    await appendReviewEvent({
      candidate,
      action: decision.decision,
      reviewerEmail: user.email,
      decision,
    });
    return noStoreJson({ decision }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The review could not be saved.";
    const isValidationError =
      /requires|cannot|unsupported|evidence-only/i.test(message);
    return noStoreJson(
      {
        error: isValidationError
          ? message
          : "The review store is temporarily unavailable.",
      },
      { status: isValidationError ? 400 : 503 }
    );
  }
}
