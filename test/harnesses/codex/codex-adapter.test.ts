import { expect, test } from "bun:test";

import { collectReviewResult } from "../../../src/harnesses/codex/codex-adapter.ts";
import {
  rpcMessageSchema,
  type RpcMessage,
} from "../../../src/harnesses/codex/protocol.ts";
import { rejectedError } from "../../support/rejected-error.ts";

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

test("refuses requests for host approval", async () => {
  const request = rpcMessageSchema.parse({
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: { command: "git status" },
  });

  expect(
    (await rejectedError(collectReviewResult(async () => request))).message,
  ).toContain(
    "read-only reviews cannot approve requests",
  );
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
