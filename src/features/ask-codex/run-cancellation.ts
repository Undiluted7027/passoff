import { HandoffInterruptedError } from "../../harnesses/harness-interruption.ts";

type RunCancellationOptions = {
  timeoutSeconds?: number;
};

/** Owns the timer and process listeners for one CLI invocation. */
export class RunCancellation {
  readonly #controller = new AbortController();
  readonly #timeout: ReturnType<typeof setTimeout> | undefined;
  readonly #onInterrupt = () => this.cancelForSignal("SIGINT", 130);
  readonly #onTerminate = () => this.cancelForSignal("SIGTERM", 143);
  #acceptingCancellation = true;

  constructor(options: RunCancellationOptions) {
    process.on("SIGINT", this.#onInterrupt);
    process.on("SIGTERM", this.#onTerminate);

    if (options.timeoutSeconds !== undefined) {
      this.#timeout = setTimeout(() => {
        this.#controller.abort(
          new HandoffInterruptedError(
            `Review exceeded its ${options.timeoutSeconds}-second deadline.`,
            "deadline_exceeded",
            1,
          ),
        );
      }, options.timeoutSeconds * 1_000);
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Keeps signal handlers in place while terminal files are committed. */
  freeze(): void {
    this.#acceptingCancellation = false;

    if (this.#timeout) {
      clearTimeout(this.#timeout);
    }
  }

  dispose(): void {
    this.freeze();

    process.off("SIGINT", this.#onInterrupt);
    process.off("SIGTERM", this.#onTerminate);
  }

  private cancelForSignal(signal: "SIGINT" | "SIGTERM", exitCode: number): void {
    if (!this.#acceptingCancellation) {
      return;
    }

    this.#controller.abort(
      new HandoffInterruptedError(
        `Review interrupted by ${signal}.`,
        "caller_cancelled",
        exitCode,
      ),
    );
  }
}

const maximumTimeoutSeconds = 2_147_483;

export function parseTimeoutSeconds(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const seconds = Number(value);

  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > maximumTimeoutSeconds
  ) {
    throw new Error(
      `The timeout must be greater than 0 and no more than ${maximumTimeoutSeconds} seconds.`,
    );
  }

  return seconds;
}
