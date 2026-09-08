import { expect, test } from "bun:test";

import {
  HandoffInterruptedError,
  isHandoffInterruptedError,
} from "../../../src/harnesses/harness-interruption.ts";
import { waitForReviewOrInterruption } from "../../../src/harnesses/codex/interruptible-review.ts";
import { rejectedError } from "../../support/rejected-error.ts";

test("finishes cancellation cleanup when the review fails first", async () => {
  const controller = new AbortController();
  const cleanupStarted = Promise.withResolvers<void>();
  const finishCleanup = Promise.withResolvers<void>();
  const reviewFailed = Promise.withResolvers<never>();
  const order: string[] = [];
  const interrupted = waitForReviewOrInterruption({
    review: reviewFailed.promise,
    signal: controller.signal,
    activeTurn: () => undefined,
    beforeInterrupt: async () => {
      order.push("cleanup started");
      cleanupStarted.resolve();
      await finishCleanup.promise;
      order.push("cleanup finished");
    },
    async interrupt() {
      throw new Error("No active turn should be interrupted.");
    },
  });

  controller.abort(
    new HandoffInterruptedError("Review interrupted.", "caller_cancelled", 130),
  );
  await cleanupStarted.promise;
  reviewFailed.reject(new Error("Tool response write failed."));

  let settled = false;
  void interrupted.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);

  finishCleanup.resolve();
  expect(isHandoffInterruptedError(await rejectedError(interrupted))).toBe(true);
  expect(order).toEqual(["cleanup started", "cleanup finished"]);
});
