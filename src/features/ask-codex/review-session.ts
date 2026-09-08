import {
  type CodexReviewInput,
} from "../../harnesses/codex/codex-adapter.ts";
import type { ReviewResult } from "./review-result.ts";
import type { SessionStore } from "./session-store.ts";

export type ReviewSessionInput = Omit<
  CodexReviewInput,
  "nativeSessionId" | "onNativeSessionOpened"
> & {
  sessionName?: string;
};

type ReviewSessionDependencies = {
  sessionStore: Pick<SessionStore, "get" | "set">;
  runReview: (input: CodexReviewInput) => Promise<ReviewResult>;
};

/** Resolves a friendly name and saves the native thread as soon as it opens. */
export async function runReviewSession(
  input: ReviewSessionInput,
  dependencies: ReviewSessionDependencies,
): Promise<ReviewResult> {
  const { sessionName, ...reviewInput } = input;
  const sessionKey = sessionName
    ? { harness: "codex", name: sessionName }
    : undefined;

  const nativeSessionId = sessionKey
    ? await dependencies.sessionStore.get(sessionKey)
    : undefined;

  return dependencies.runReview({
    ...reviewInput,
    nativeSessionId,
    async onNativeSessionOpened(openedSessionId) {
      // Save before the turn starts. A malformed result or failed turn should
      // not discard a native thread that Codex can still resume.
      if (sessionKey) {
        await dependencies.sessionStore.set(sessionKey, openedSessionId);
      }
    },
  });
}
