import { expect, test } from "bun:test";

import { createClaudeReviewTool } from "../../../src/features/codex-to-claude/claude-review-tool.ts";
import {
  GIT_CHANGE_LIMITS,
  type GitChangeContext,
} from "../../../src/features/codex-to-claude/git-change-context.ts";
import type { ClaudeReviewInput } from "../../../src/harnesses/claude/claude-adapter.ts";
import { rejectedError } from "../../support/rejected-error.ts";

const changeContext: GitChangeContext = {
  baseRevision: "abc123",
  complete: true,
  limits: GIT_CHANGE_LIMITS,
  files: {
    entries: [{ path: "src/example.ts", kind: "tracked" }],
    total: 1,
    omitted: 0,
  },
  patch: {
    text: "diff --git a/src/example.ts b/src/example.ts\n",
    totalBytes: 45,
    omittedBytes: 0,
    encodingLoss: false,
  },
};

test("the tool saves and resumes Claude's opaque session ID", async () => {
  let storedSession: string | undefined;
  let contextReads = 0;
  const receivedSessionIds: Array<string | undefined> = [];
  const receivedPrompts: string[] = [];
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
      async readChangeContext() {
        contextReads += 1;
        const text = `patch from context read ${contextReads}`;

        return {
          ...changeContext,
          patch: {
            text,
            totalBytes: Buffer.byteLength(text),
            omittedBytes: 0,
            encodingLoss: false,
          },
        };
      },
      async runReview(input: ClaudeReviewInput) {
        receivedSessionIds.push(input.nativeSessionId);
        receivedPrompts.push(input.prompt);
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
  expect(receivedPrompts[0]).toContain("patch from context read 1");
  expect(receivedPrompts[1]).toContain("patch from context read 2");
});

test("a Git context failure prevents Claude from starting", async () => {
  let reviewStarted = false;
  const tool = createClaudeReviewTool(
    {
      cwd: "/repo",
      baseRevision: "abc123",
      onProgress: () => undefined,
    },
    {
      sessionStore: {
        async get() {
          return undefined;
        },
        async set() {},
      },
      async readChangeContext() {
        throw new Error("Could not compute Git change context.");
      },
      async runReview() {
        reviewStarted = true;
        throw new Error("Claude should not start.");
      },
    },
  );

  const error = await rejectedError(
    tool.execute({ task: "Review this.", session: "failure" }),
  );

  expect(error.message).toBe("Could not compute Git change context.");
  expect(reviewStarted).toBe(false);
});
