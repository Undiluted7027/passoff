import { expect, test } from "bun:test";

import { collectReviewResult } from "../../../src/harnesses/codex/codex-adapter.ts";
import {
  rpcMessageSchema,
  type RpcMessage,
} from "../../../src/harnesses/codex/protocol.ts";
import { rejectedError } from "../../support/rejected-error.ts";
import {
  HandoffInterruptedError,
  isHandoffInterruptedError,
} from "../../../src/harnesses/harness-interruption.ts";
import { waitForReviewOrInterruption } from "../../../src/harnesses/codex/interruptible-review.ts";

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

test("answers the registered dynamic tool and continues the Codex turn", async () => {
  const messages = await loadFixture("completed-review.jsonl");
  const toolRequest = rpcMessageSchema.parse({
    id: 42,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "ask_claude",
      arguments: { task: "Review this.", session: "second-opinion" },
    },
  });
  const responses: unknown[] = [];

  const result = await collectReviewResult(
    readInOrder([toolRequest, ...messages]),
    undefined,
    undefined,
    {
      tool: {
        name: "ask_claude",
        description: "Ask Claude.",
        inputSchema: {},
        async execute(argumentsValue) {
          expect(argumentsValue).toEqual({
            task: "Review this.",
            session: "second-opinion",
          });
          return '{"status":"approved"}';
        },
      },
      async respond(id, response) {
        responses.push({ id, response });
      },
    },
  );

  expect(responses).toEqual([
    {
      id: 42,
      response: {
        contentItems: [
          { type: "inputText", text: '{"status":"approved"}' },
        ],
        success: true,
      },
    },
  ]);
  expect(result.status).toBe("changes_requested");
});

test("answers an interrupted dynamic tool before interrupting the Codex turn", async () => {
  const controller = new AbortController();
  const toolStarted = Promise.withResolvers<void>();
  const order: string[] = [];
  const responses: Array<{ success: boolean; text: string }> = [];
  let callAcknowledged: Promise<void> | undefined;
  let acknowledgeCall: (() => void) | undefined;
  let deliveredRequest = false;
  let deliveredAcknowledgement = false;

  const toolRequest = rpcMessageSchema.parse({
    id: 43,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-2",
      namespace: null,
      tool: "ask_claude",
      arguments: { task: "Review this.", session: "interrupted-review" },
    },
  });

  const review = collectReviewResult(
    async () => {
      if (!deliveredRequest) {
        deliveredRequest = true;
        return toolRequest;
      }

      if (!deliveredAcknowledgement) {
        deliveredAcknowledgement = true;
        return rpcMessageSchema.parse({
          method: "item/completed",
          params: {
            item: {
              type: "dynamicToolCall",
              id: "call-2",
              status: "failed",
            },
          },
        });
      }

      return new Promise<RpcMessage>(() => undefined);
    },
    undefined,
    undefined,
    {
      signal: controller.signal,
      tool: {
        name: "ask_claude",
        description: "Ask Claude.",
        inputSchema: {},
        async execute() {
          toolStarted.resolve();
          return new Promise<string>(() => undefined);
        },
      },
      async respond(_id, response) {
        order.push("tool response");
        responses.push({
          success: response.success,
          text: response.contentItems[0]?.text ?? "",
        });
      },
      onCallStarted(callId) {
        expect(callId).toBe("call-2");
        const acknowledgement = Promise.withResolvers<void>();
        callAcknowledged = acknowledgement.promise;
        acknowledgeCall = acknowledgement.resolve;
      },
      onCallAcknowledged(callId) {
        expect(callId).toBe("call-2");
        order.push("tool acknowledged");
        acknowledgeCall?.();
      },
    },
  );
  const interrupted = waitForReviewOrInterruption({
    review,
    signal: controller.signal,
    activeTurn: () => ({ threadId: "thread-1", turnId: "turn-1" }),
    beforeInterrupt: async () => {
      await callAcknowledged;
    },
    async interrupt() {
      order.push("turn interrupt");
    },
  });

  await toolStarted.promise;
  controller.abort(
    new HandoffInterruptedError("Review interrupted.", "caller_cancelled", 130),
  );

  expect(isHandoffInterruptedError(await rejectedError(interrupted))).toBe(true);
  expect(order).toEqual([
    "tool response",
    "tool acknowledged",
    "turn interrupt",
  ]);
  expect(responses).toEqual([
    { success: false, text: "Review interrupted." },
  ]);
});
