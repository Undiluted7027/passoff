import { interruptionFromSignal } from "../harness-interruption.ts";

export type ActiveCodexTurn = {
  threadId: string;
  turnId: string;
};

type InterruptibleReview<T> = {
  review: Promise<T>;
  signal?: AbortSignal;
  activeTurn: () => ActiveCodexTurn | undefined;
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
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterruption = reject;
  });
  const interruptThenReject = async () => {
    const turn = input.activeTurn();

    if (turn) {
      // Native interruption is best effort. The app-server process is closed by
      // the adapter afterward, so a stuck response cannot block cancellation.
      await interruptWithin(turn, input.interrupt);
    }

    rejectInterruption(interruptionFromSignal(signal));
  };
  const onAbort = () => {
    void interruptThenReject();
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    return await Promise.race([input.review, interrupted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function interruptWithin(
  turn: ActiveCodexTurn,
  interrupt: (turn: ActiveCodexTurn) => Promise<void>,
): Promise<void> {
  await settleWithin(interrupt(turn), 1_000);
}

async function settleWithin(operation: Promise<void>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const timeout = setTimeout(finish, timeoutMs);

    function finish(): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve();
    }

    operation.then(finish, finish);
  });
}
