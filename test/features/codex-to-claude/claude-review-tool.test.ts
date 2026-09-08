import { expect, test } from "bun:test";

import { createClaudeReviewTool } from "../../../src/features/codex-to-claude/claude-review-tool.ts";
import type { ClaudeReviewInput } from "../../../src/harnesses/claude/claude-adapter.ts";

test("the tool saves and resumes Claude's opaque session ID", async () => {
  let storedSession: string | undefined;
  const receivedSessionIds: Array<string | undefined> = [];
  const tool = createClaudeReviewTool(
    {
      cwd: "/repo",
      baseRevision: "abc123",
      onProgress: () => undefined,
    },
    {
      sessionStore: {
        async get() {
          return storedSession;
        },
        async set(_key, nativeSessionId) {
          storedSession = nativeSessionId;
        },
      },
      async runReview(input: ClaudeReviewInput) {
        receivedSessionIds.push(input.nativeSessionId);
        await input.onNativeSessionOpened(input.nativeSessionId ?? "claude-1");
        return {
          status: "approved",
          summary: "No findings.",
          checks: [],
          findings: [],
        };
      },
    },
  );

  await tool.execute({ task: "Review this.", session: "second-opinion" });
  await tool.execute({ task: "Check the fix.", session: "second-opinion" });

  expect(receivedSessionIds).toEqual([undefined, "claude-1"]);
});
