import { expect, test } from "bun:test";

import { collectReviewResult } from "../../../src/harnesses/codex/codex-adapter.ts";
import {
  rpcMessageSchema,
  type RpcMessage,
} from "../../../src/harnesses/codex/protocol.ts";
import { rejectedError } from "../../support/rejected-error.ts";
import { isHandoffInterruptedError } from "../../../src/harnesses/harness-interruption.ts";

// Fixtures are sanitized app-server messages. Loading them from disk keeps the
// ordinary test suite deterministic and prevents accidental model usage.
async function loadFixture(name: string): Promise<RpcMessage[]> {
  const text = await Bun.file(
    new URL(`../../fixtures/codex/${name}`, import.meta.url),
  ).text();

  return text
    .trim()
    .split("\n")
    .map((line) => rpcMessageSchema.parse(JSON.parse(line)));
}

function readInOrder(messages: RpcMessage[]): () => Promise<RpcMessage> {
  const unread = [...messages];

  return async () => {
    const message = unread.shift();

    if (!message) {
      throw new Error("Fixture ended before the adapter returned.");
    }

    return message;
  };
}

test("uses the final answer and ignores earlier commentary", async () => {
  const messages = await loadFixture("completed-review.jsonl");

  const result = await collectReviewResult(readInOrder(messages));

  expect(result.status).toBe("changes_requested");
  expect(result.summary).toBe("One authorization gap.");
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]).not.toHaveProperty("suggestedFix");
});

test("rejects malformed review output after a successful native turn", async () => {
  const messages = await loadFixture("malformed-review.jsonl");

  expect(
    (await rejectedError(collectReviewResult(readInOrder(messages)))).message,
  ).toContain(
    "Codex returned an invalid review result",
  );
});

test("turns a host approval request into a blocked review", async () => {
  const request = rpcMessageSchema.parse({
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: { command: "git status" },
  });

  const approvals: string[] = [];
  const result = await collectReviewResult(
    async () => request,
    undefined,
    async (method) => {
      approvals.push(method);
    },
  );

  expect(result).toMatchObject({
    status: "blocked",
    summary: expect.stringContaining("read-only reviews cannot approve requests"),
  });
  expect(approvals).toEqual(["item/commandExecution/requestApproval"]);
});

test("classifies non-completed native turns", async () => {
  const nativeFailure = rpcMessageSchema.parse({
    method: "turn/completed",
    params: {
      turn: {
        status: "failed",
        error: { message: "Authentication expired" },
      },
    },
  });

  expect(
    (await rejectedError(collectReviewResult(async () => nativeFailure))).message,
  ).toBe("Authentication expired");

  const nativeInterruption = rpcMessageSchema.parse({
    method: "turn/completed",
    params: { turn: { status: "interrupted" } },
  });
  const error = await rejectedError(
    collectReviewResult(async () => nativeInterruption),
  );

  expect(isHandoffInterruptedError(error)).toBe(true);

  if (!isHandoffInterruptedError(error)) {
    throw new Error("Expected an interrupted handoff error.");
  }

  expect(error.code).toBe("native_interruption");
});

test("continues after a retryable Codex error", async () => {
  const messages = await loadFixture("completed-review.jsonl");
  const progress: string[] = [];
  const retryableError = rpcMessageSchema.parse({
    method: "error",
    params: {
      error: { message: "Connection reset" },
      willRetry: true,
      threadId: "thread-1",
      turnId: "turn-1",
    },
  });

  const result = await collectReviewResult(
    readInOrder([retryableError, ...messages]),
    (text) => progress.push(text),
  );

  expect(result.status).toBe("changes_requested");
  expect(progress.join("")).toContain("will retry");
});
