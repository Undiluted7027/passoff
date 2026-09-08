import { z } from "zod";

import { buildReviewPrompt, reviewOutputSchema } from "../ask-codex/review-prompt.ts";
import type { ReviewResult } from "../ask-codex/review-result.ts";
import type { SessionStore } from "../ask-codex/session-store.ts";
import {
  runClaudeReview,
  type ClaudeReviewInput,
} from "../../harnesses/claude/claude-adapter.ts";
import type { CodexDynamicTool } from "../../harnesses/codex/codex-adapter.ts";
import {
  formatGitChangeContext,
  readGitChangeContext,
  type GitChangeContext,
} from "./git-change-context.ts";

const claudeReviewRequestSchema = z.strictObject({
  task: z.string().trim().min(1),
  session: z.string().trim().min(1),
});

type ClaudeReviewToolInput = {
  cwd: string;
  baseRevision: string;
  signal?: AbortSignal;
  onProgress: (text: string) => void;
  onProviderMessage?: (message: unknown) => void;
};

type ClaudeReviewToolDependencies = {
  sessionStore: Pick<SessionStore, "get" | "set">;
  readChangeContext?: (
    repository: string,
    baseRevision: string,
    signal?: AbortSignal,
  ) => Promise<GitChangeContext>;
  runReview?: (input: ClaudeReviewInput) => Promise<ReviewResult>;
};

/** Creates the single host callback Codex may use to request a Claude review. */
export function createClaudeReviewTool(
  input: ClaudeReviewToolInput,
  dependencies: ClaudeReviewToolDependencies,
): CodexDynamicTool {
  const runReview = dependencies.runReview ?? runClaudeReview;
  const readChangeContext =
    dependencies.readChangeContext ?? readGitChangeContext;

  return {
    name: "ask_claude",
    description:
      "Ask Claude Code for a read-only review of the current repository. Reuse a session name for follow-up reviews.",
    inputSchema: z.toJSONSchema(claudeReviewRequestSchema),
    async execute(argumentsValue) {
      const request = claudeReviewRequestSchema.parse(argumentsValue);
      const changeContext = await readChangeContext(
        input.cwd,
        input.baseRevision,
        input.signal,
      );
      const sessionKey = { harness: "claude", name: request.session };
      const nativeSessionId = await dependencies.sessionStore.get(sessionKey);

      input.onProgress(
        `${nativeSessionId ? "Resumed" : "Starting"} Claude review.\n`,
      );

      const result = await runReview({
        cwd: input.cwd,
        prompt: buildReviewPrompt({
          task: request.task,
          repository: input.cwd,
          baseRevision: input.baseRevision,
          changeContext: formatGitChangeContext(changeContext),
        }),
        outputSchema: reviewOutputSchema,
        nativeSessionId,
        signal: input.signal,
        onProgress: input.onProgress,
        onProviderMessage: input.onProviderMessage,
        async onNativeSessionOpened(openedSessionId) {
          // Save before parsing the result so a failed first turn remains resumable.
          await dependencies.sessionStore.set(sessionKey, openedSessionId);
        },
      });

      return JSON.stringify(result);
    },
  };
}
