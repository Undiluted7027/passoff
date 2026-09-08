export type InterruptionCode =
  | "caller_cancelled"
  | "deadline_exceeded"
  | "native_interruption";

/** Carries the stable reason and exit code for an interrupted handoff. */
export class HandoffInterruptedError extends Error {
  readonly name = "HandoffInterruptedError";

  constructor(
    message: string,
    readonly code: InterruptionCode,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

export function interruptionFromSignal(signal: AbortSignal): HandoffInterruptedError {
  const reason: unknown = signal.reason;

  return reason instanceof HandoffInterruptedError
    ? reason
    : new HandoffInterruptedError(
        "Review was interrupted.",
        "caller_cancelled",
        1,
      );
}

export function throwIfInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw interruptionFromSignal(signal);
  }
}

export function isHandoffInterruptedError(
  error: unknown,
): error is HandoffInterruptedError {
  return error instanceof HandoffInterruptedError;
}
