import { expect, test } from "bun:test";

import { readJsonLines } from "../../../src/harnesses/codex/json-lines.ts";

test("parses an app-server message split across stream chunks", async () => {
  async function* splitMessage() {
    yield '{"method":"turn/compl';
    yield 'eted","params":{"turn":{"status":"completed"}}}\n';
  }

  const messages = [];

  for await (const message of readJsonLines(splitMessage())) {
    messages.push(message);
  }

  expect(messages).toEqual([
    { method: "turn/completed", params: { turn: { status: "completed" } } },
  ]);
});
