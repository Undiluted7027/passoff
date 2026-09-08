import { interruptionFromSignal } from "../harness-interruption.ts";

export type ActiveCodexTurn = {
  threadId: string;
  turnId: string;
};

type InterruptibleReview<T> = {
  review: Promise<T>;
  signal?: AbortSignal;
  activeTurn: () => ActiveCodexTurn | undefined;
  beforeInterrupt?: () => Promise<void>;
  interrupt: (turn: ActiveCodexTurn) => Promise<void>;
};

/** Lets a caller stop a review while giving the native turn time to close. */
export async function waitForReviewOrInterruption<T>(
  input: InterruptibleReview<T>,
): Promise<T> {
  if (!input.signal) {
    return input.review;
  }

  const signal = input.signal;
  let rejectInterruption: (error: Error) => void = () => undefined;
  let cancellationCleanup: Promise<void> | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterruption = reject;
  });
  const interruptThenReject = async (): Promise<void> => {
    await input.beforeInterrupt?.().catch(() => undefined);
    const turn = input.activeTurn();

    if (turn) {
      // Native interruption is best effort. The app-server process is closed by
      // the adapter afterward, so a stuck response cannot block cancellation.
      await interruptWithin(turn, input.interrupt);
    }

    rejectInterruption(interruptionFromSignal(signal));
  };
  const onAbort = () => {
    cancellationCleanup ??= interruptThenReject();
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  let result: T;

  try {
    result = await Promise.race([input.review, interrupted]);
  } catch (error) {
    if (!cancellationCleanup) {
      throw error;
    }

    // A provider failure can race with cancellation. Finish cleanup before
    // exposing either outcome so an immediate retry cannot resume bad state.
    await cancellationCleanup;
    throw interruptionFromSignal(signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  if (cancellationCleanup) {
    await cancellationCleanup;
    throw interruptionFromSignal(signal);
  }

  return result;
}

export async function interruptWithin(
  turn: ActiveCodexTurn,
  interrupt: (turn: ActiveCodexTurn) => Promise<void>,
): Promise<void> {
  await settleWithin(interrupt(turn), 1_000);
}

export async function settleWithin(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let finished = false;
    const timeout = setTimeout(() => finish(false), timeoutMs);

    function finish(settled: boolean): void {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timeout);
      resolve(settled);
    }

    operation.then(
      () => finish(true),
      () => finish(true),
    );
  });
}
