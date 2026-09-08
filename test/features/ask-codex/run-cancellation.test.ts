import { expect, test } from "bun:test";

import { RunCancellation } from "../../../src/features/ask-codex/run-cancellation.ts";

test("freezing ignores deadlines while terminal state is persisted", async () => {
  const cancellation = new RunCancellation({ timeoutSeconds: 0.01 });

  try {
    cancellation.freeze();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cancellation.signal.aborted).toBe(false);
  } finally {
    cancellation.dispose();
  }
});
