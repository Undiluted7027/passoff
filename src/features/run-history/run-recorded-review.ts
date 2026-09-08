import type { CodexReviewInput } from "../../harnesses/codex/codex-adapter.ts";
import type { ReviewResult } from "../ask-codex/review-result.ts";
import {
  runReviewSession,
  type ReviewSessionInput,
} from "../ask-codex/review-session.ts";
import type { SessionStore } from "../ask-codex/session-store.ts";
import {
  isHandoffInterruptedError,
  throwIfInterrupted,
} from "../../harnesses/harness-interruption.ts";
import type { HarnessId } from "./run-record.ts";
import type { RunStore } from "./run-store.ts";

type RecordedReviewInput = {
  review: ReviewSessionInput;
  task: string;
  baseRevision: string;
  sourceHarness?: HarnessId;
  debugCapture: boolean;
  repositoryFingerprint: string;
};

type RecordedReviewDependencies = {
  sessionStore: Pick<SessionStore, "get" | "set" | "delete">;
  runStore: Pick<RunStore, "start">;
  runReview: (input: CodexReviewInput) => Promise<ReviewResult>;
  readRepositoryFingerprint: (
    repository: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  onTerminalStateDecided: () => void;
};

/** Runs one review while keeping its Passoff-owned audit record in sync. */
export async function runRecordedReview(
  input: RecordedReviewInput,
  dependencies: RecordedReviewDependencies,
): Promise<ReviewResult> {
  let terminalStateDecided = false;
  const decideTerminalState = () => {
    if (!terminalStateDecided) {
      terminalStateDecided = true;
      dependencies.onTerminalStateDecided();
    }
  };
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
        onApprovalRequired: (method) => run.approvalRequired(method),
      },
    );

    throwIfInterrupted(input.review.signal);
    let currentFingerprint: string;

    try {
      currentFingerprint = await dependencies.readRepositoryFingerprint(
        input.review.cwd,
        input.review.signal,
      );
    } catch (error) {
      // Node reports its own AbortError. Keep Passoff's stable deadline or
      // caller-cancellation reason in the run record and CLI output.
      throwIfInterrupted(input.review.signal);
      throw error;
    }

    throwIfInterrupted(input.review.signal);

    if (currentFingerprint !== input.repositoryFingerprint) {
      throw new Error(
        "The repository changed during the review. Run the review again before using its verdict.",
      );
    }

    // Signals stop changing the outcome once terminal persistence begins.
    decideTerminalState();
    await run.complete(result);
    return result;
  } catch (error) {
    decideTerminalState();

    if (isHandoffInterruptedError(error)) {
      await run.interrupt(error);
    } else {
      await run.fail(error);
    }

    throw error;
  }
}
