import { join } from "node:path";

import type { ReviewResult } from "../ask-codex/review-result.ts";
import {
  writeJsonAtomically,
  writeTextAtomically,
} from "../local-state/repository-state.ts";
import { ProviderCapture } from "./provider-capture.ts";
import {
  type HandoffFile,
  type RunEvent,
  runEventSchema,
  runResultFileSchema,
} from "./run-record.ts";

/** Owns the files that change while one handoff is running. */
export class ActiveRun {
  readonly #providerCapture: ProviderCapture | undefined;

  private constructor(
    private readonly directory: string,
    private handoff: HandoffFile,
    private readonly events: RunEvent[],
    debugCapture: boolean,
  ) {
    this.#providerCapture = debugCapture ? new ProviderCapture() : undefined;
  }

  static async create(
    directory: string,
    handoff: HandoffFile,
    events: RunEvent[],
    debugCapture: boolean,
  ): Promise<ActiveRun> {
    const run = new ActiveRun(directory, handoff, events, debugCapture);
    await writeJsonAtomically(run.path("handoff.json"), handoff);
    await run.writeEvents();
    return run;
  }

  captureProviderMessage(value: unknown): void {
    this.#providerCapture?.add(value);
  }

  async sessionStarted(nativeSessionId: string): Promise<void> {
    this.assertRunning();
    this.handoff = { ...this.handoff, nativeSessionId };
    await writeJsonAtomically(this.path("handoff.json"), this.handoff);
    await this.addEvent({
      type: "session.started",
      timestamp: new Date().toISOString(),
      sessionId: nativeSessionId,
    });
  }

  async approvalRequired(method: string): Promise<void> {
    this.assertRunning();
    await this.addEvent({
      type: "approval.required",
      timestamp: new Date().toISOString(),
      method,
    });
  }

  async complete(review: ReviewResult): Promise<void> {
    this.assertRunning();
    const finishedAt = new Date().toISOString();
    const result = runResultFileSchema.parse({
      version: 1,
      runId: this.handoff.runId,
      status: review.status,
      finishedAt,
      review,
    });

    await writeJsonAtomically(this.path("result.json"), result);
    await this.writeProviderExcerpts();
    await this.addEvent({
      type: "session.completed",
      timestamp: finishedAt,
      status: review.status,
    });
    await this.finish({ status: review.status, finishedAt, failureReason: null });
  }

  async fail(error: unknown): Promise<void> {
    await this.finishWithoutReview("failed", error);
  }

  async interrupt(error: unknown): Promise<void> {
    await this.finishWithoutReview("interrupted", error);
  }

  private async finishWithoutReview(
    status: "failed" | "interrupted",
    error: unknown,
  ): Promise<void> {
    this.assertRunning();
    const finishedAt = new Date().toISOString();
    const failureReason = errorMessage(error);
    const result = runResultFileSchema.parse({
      version: 1,
      runId: this.handoff.runId,
      status,
      finishedAt,
      failureReason,
    });

    await writeJsonAtomically(this.path("result.json"), result);
    await this.writeProviderExcerpts();
    const event: RunEvent =
      status === "failed"
        ? { type: "session.failed", timestamp: finishedAt, message: failureReason }
        : {
            type: "session.interrupted",
            timestamp: finishedAt,
            message: failureReason,
          };
    await this.addEvent(event);
    await this.finish({ status, finishedAt, failureReason });
  }

  private async finish(
    terminal: Pick<HandoffFile, "status" | "finishedAt" | "failureReason">,
  ): Promise<void> {
    this.handoff = { ...this.handoff, ...terminal };
    await writeJsonAtomically(this.path("handoff.json"), this.handoff);
  }

  private async addEvent(event: RunEvent): Promise<void> {
    this.events.push(runEventSchema.parse(event));
    await this.writeEvents();
  }

  private async writeEvents(): Promise<void> {
    // This POC records only a few lifecycle events. Replacing the short file
    // keeps every visible event log parseable without building a log database.
    const text = `${this.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    await writeTextAtomically(this.path("events.ndjson"), text);
  }

  private async writeProviderExcerpts(): Promise<void> {
    if (this.#providerCapture) {
      await writeJsonAtomically(
        this.path("provider.json"),
        this.#providerCapture.values(),
      );
    }
  }

  private assertRunning(): void {
    if (this.handoff.status !== "running") {
      throw new Error(`Passoff run ${this.handoff.runId} is already finished.`);
    }
  }

  private path(name: string): string {
    return join(this.directory, name);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "Passoff run failed.";
}
