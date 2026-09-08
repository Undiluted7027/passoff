import { expect, test } from "bun:test";
import { z } from "zod";

import {
  JsonRpcConnection,
  type RpcTransport,
} from "../../../src/harnesses/codex/json-rpc-connection.ts";
import { rejectedError } from "../../support/rejected-error.ts";

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
