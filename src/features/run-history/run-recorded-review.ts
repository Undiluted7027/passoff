import type { CodexReviewInput } from "../../harnesses/codex/codex-adapter.ts";
import type { ReviewResult } from "../ask-codex/review-result.ts";
import {
  runReviewSession,
  type ReviewSessionInput,
} from "../ask-codex/review-session.ts";
import type { SessionStore } from "../ask-codex/session-store.ts";
import type { HarnessId } from "./run-record.ts";
import type { RunStore } from "./run-store.ts";

type RecordedReviewInput = {
  review: ReviewSessionInput;
  task: string;
  baseRevision: string;
  sourceHarness?: HarnessId;
  debugCapture: boolean;
};

type RecordedReviewDependencies = {
  sessionStore: Pick<SessionStore, "get" | "set">;
  runStore: Pick<RunStore, "start">;
  runReview: (input: CodexReviewInput) => Promise<ReviewResult>;
};

/** Runs one review while keeping its Passoff-owned audit record in sync. */
export async function runRecordedReview(
  input: RecordedReviewInput,
  dependencies: RecordedReviewDependencies,
): Promise<ReviewResult> {
  const run = await dependencies.runStore.start({
    task: input.task,
    repository: input.review.cwd,
    baseRevision: input.baseRevision,
    sourceHarness: input.sourceHarness,
    targetHarness: "codex",
    sessionName: input.review.sessionName,
    debugCapture: input.debugCapture,
  });
  try {
    const result = await runReviewSession(
      input.review,
      {
        sessionStore: dependencies.sessionStore,
        runReview: dependencies.runReview,
        onSessionStarted: (nativeSessionId) =>
          run.sessionStarted(nativeSessionId),
        // Raw messages remain transient. ActiveRun stores only a sanitized
        // copy, and only when the caller opted into debug capture.
        onProviderMessage: (message) => run.captureProviderMessage(message),
      },
    );

    await run.complete(result);
    return result;
  } catch (error) {
    await run.fail(error);
    throw error;
  }
}
