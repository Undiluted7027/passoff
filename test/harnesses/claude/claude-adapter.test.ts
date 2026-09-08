import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildClaudeArguments,
  collectClaudeReview,
  runClaudeReview,
} from "../../../src/harnesses/claude/claude-adapter.ts";
import { HandoffInterruptedError } from "../../../src/harnesses/harness-interruption.ts";
import { readJsonLines } from "../../../src/harnesses/codex/json-lines.ts";

const fixtureDirectory = join(import.meta.dir, "../../fixtures/claude");

async function fixture(name: string): Promise<unknown[]> {
  const text = await readFile(join(fixtureDirectory, name), "utf8");
  const chunks = [text.slice(0, 37), text.slice(37)];
  const messages: unknown[] = [];

  async function* streamChunks() {
    yield* chunks;
  }

  for await (const message of readJsonLines(streamChunks(), "Claude Code")) {
    messages.push(message);
  }

  return messages;
}

test("new and resumed reviews use the same read-only restrictions", () => {
  const outputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
  };
  const first = buildClaudeArguments({
    prompt: "Review the change.",
    outputSchema,
  });
  const resumed = buildClaudeArguments({
    prompt: "Check the fix.",
    outputSchema: {},
    nativeSessionId: "claude-session-1",
  });

  for (const args of [first, resumed]) {
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("dontAsk");
    expect(args).toContain("--permission-prompts");
    expect(args).toContain("none");
    expect(args).toContain("Read,Glob,Grep");
  }

  expect(first).not.toContain("--resume");
  expect(resumed).toContain("--resume");
  expect(resumed).toContain("claude-session-1");

  const serializedSchema = first[first.indexOf("--json-schema") + 1];
  expect(JSON.parse(serializedSchema ?? "null")).toEqual({ type: "object" });
});

test("permission denials block an otherwise successful Claude result", async () => {
  const messages = await fixture("permission-denied.jsonl");
  const approvals: string[] = [];

  const result = await collectClaudeReview(messages, {
    onNativeSessionOpened: async () => undefined,
    onApprovalRequired: async (method) => {
      approvals.push(method);
    },
  });

  expect(result).toMatchObject({
    status: "blocked",
    summary: expect.stringContaining("Bash"),
  });
  expect(approvals).toEqual(["Bash"]);
});

test("a completed Claude stream returns its structured review", async () => {
  const messages = await fixture("completed-review.jsonl");
  const sessions: string[] = [];
  const progress: string[] = [];

  const result = await collectClaudeReview(messages, {
    onNativeSessionOpened: async (id) => {
      sessions.push(id);
    },
    onProgress: (text) => progress.push(text),
  });

  expect(sessions).toEqual(["claude-session-1"]);
  expect(progress).toEqual([
    "Claude is reviewing.\n",
    "Claude is using Read.\n",
  ]);
  expect(result).toEqual({
    status: "changes_requested",
    summary: "One finding.",
    checks: [],
    findings: [{ severity: "low", problem: "Clarify the command." }],
  });
});

test("an interrupted Claude review stops and closes its process", async () => {
  const controller = new AbortController();
  const streamStopped = Promise.withResolvers<void>();
  const sessionOpened = Promise.withResolvers<void>();
  let interruptCalls = 0;
  let closeCalls = 0;

  const review = runClaudeReview(
    {
      cwd: "/repo",
      prompt: "Review the change.",
      outputSchema: {},
      signal: controller.signal,
      onProgress: () => undefined,
      async onNativeSessionOpened() {
        sessionOpened.resolve();
      },
    },
    {
      startProcess: () => ({
        messages: (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "claude-session-3",
          };
          await streamStopped.promise;
        })(),
        interrupt() {
          interruptCalls += 1;
          streamStopped.resolve();
        },
        async close() {
          closeCalls += 1;
          streamStopped.resolve();
        },
      }),
    },
  );

  await sessionOpened.promise;
  controller.abort(
    new HandoffInterruptedError("Review timed out.", "deadline_exceeded", 1),
  );

  await expect(review).rejects.toMatchObject({
    message: "Review timed out.",
    code: "deadline_exceeded",
  });
  expect(interruptCalls).toBe(1);
  expect(closeCalls).toBe(1);
});
