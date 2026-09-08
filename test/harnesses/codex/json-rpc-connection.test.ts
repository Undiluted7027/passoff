import { expect, test } from "bun:test";
import { z } from "zod";

import {
  JsonRpcConnection,
  type RpcTransport,
} from "../../../src/harnesses/codex/json-rpc-connection.ts";
import { rejectedError } from "../../support/rejected-error.ts";

class ControlledTransport implements RpcTransport {
  readonly sent: unknown[] = [];
  readonly #messages: unknown[] = [];
  #resume: (() => void) | undefined;
  #closed = false;

  readonly messages = this.readMessages();

  push(message: unknown): void {
    this.#messages.push(message);
    this.#resume?.();
  }

  async send(message: unknown): Promise<void> {
    this.sent.push(message);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#resume?.();
  }

  private async *readMessages(): AsyncGenerator<unknown> {
    while (!this.#closed) {
      const message = this.#messages.shift();

      if (message !== undefined) {
        yield message;
        continue;
      }

      await new Promise<void>((resolve) => {
        this.#resume = resolve;
      });
      this.#resume = undefined;
    }
  }
}

test("rejects requests made after the app-server reader stops", async () => {
  const closedTransport: RpcTransport = {
    messages: (async function* () {
      return;
    })(),
    async send() {
      throw new Error("A closed transport must not be written to.");
    },
    async close() {},
  };
  const connection = new JsonRpcConnection(closedTransport);

  // Let the background reader observe EOF before making the request. This is
  // the race that previously left a request promise unresolved forever.
  await Promise.resolve();

  const request = connection.request(
    "model/list",
    {},
    z.object({ data: z.array(z.never()) }),
  );

  expect((await rejectedError(request)).message).toContain(
    "closed before the review completed",
  );
});

test("correlates a server request response with its original ID", async () => {
  const transport = new ControlledTransport();
  const connection = new JsonRpcConnection(transport);

  transport.push({
    id: "tool-request-7",
    method: "item/tool/call",
    params: { tool: "ask_claude", arguments: { task: "Review this." } },
  });

  const request = await connection.nextServerMessage();
  await connection.respond(request.id!, {
    contentItems: [{ type: "inputText", text: "done" }],
    success: true,
  });

  expect(transport.sent.at(-1)).toEqual({
    id: "tool-request-7",
    result: {
      contentItems: [{ type: "inputText", text: "done" }],
      success: true,
    },
  });

  await connection.close();
});
