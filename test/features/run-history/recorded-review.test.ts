import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReviewResult } from "../../../src/features/ask-codex/review-result.ts";
import { RunCancellation } from "../../../src/features/ask-codex/run-cancellation.ts";
import { SessionStore } from "../../../src/features/ask-codex/session-store.ts";
import { runRecordedReview } from "../../../src/features/run-history/run-recorded-review.ts";
import { RunStore } from "../../../src/features/run-history/run-store.ts";
import { waitForReviewOrInterruption } from "../../../src/harnesses/codex/interruptible-review.ts";
import { rejectedError } from "../../support/rejected-error.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "passoff-recorded-review-test-"));
  const repository = join(root, "repository");
  const stateDirectory = join(root, "state");
  temporaryDirectories.push(root);
  await mkdir(repository, { recursive: true });

  return {
    repository,
    stateDirectory,
    runStore: await RunStore.forRepository(repository, stateDirectory),
    sessionStore: await SessionStore.forRepository(repository, stateDirectory),
  };
}

const approvedReview: ReviewResult = {
  status: "approved",
  summary: "No findings.",
  findings: [],
  checks: [],
};

test("a failed run keeps its session and normalized lifecycle", async () => {
  const { repository, runStore, sessionStore } = await createRepository();
  const review = runRecordedReview(
    {
      review: {
        cwd: repository,
        sessionName: "auth-review",
        prompt: "Review the authorization changes.",
        outputSchema: {},
        onProgress: () => undefined,
      },
      task: "Review the authorization changes.",
      baseRevision: "abc123",
      sourceHarness: "claude",
      debugCapture: false,
      repositoryFingerprint: "unchanged",
    },
    {
      sessionStore,
      runStore,
      async runReview(input) {
        await input.onNativeSessionOpened("thread-1");
        throw new Error("Codex stopped before returning a result.");
      },
      readRepositoryFingerprint: async () => "unchanged",
      onTerminalStateDecided: () => undefined,
    },
  );

  expect((await rejectedError(review)).message).toContain(
    "Codex stopped before returning a result.",
  );

  const saved = await runStore.latest({
    harness: "codex",
    name: "auth-review",
  });
  expect(saved?.handoff.status).toBe("failed");
  expect(saved?.handoff.nativeSessionId).toBe("thread-1");
  expect(saved?.events.map((event) => event.type)).toEqual([
    "handoff.started",
    "session.started",
    "session.failed",
  ]);
  expect(saved?.result).toMatchObject({
    status: "failed",
    failureReason: "Codex stopped before returning a result.",
  });
  expect(saved?.providerExcerpts).toBeUndefined();
});

test("a deadline interrupts the native turn and records an interrupted run", async () => {
  const { repository, runStore, sessionStore } = await createRepository();
  const cancellation = new RunCancellation({ timeoutSeconds: 0.01 });
  let interruptedTurn: { threadId: string; turnId: string } | undefined;

  try {
    const review = runRecordedReview(
      {
        review: {
          cwd: repository,
          sessionName: "deadline-review",
          prompt: "Review until interrupted.",
          outputSchema: {},
          signal: cancellation.signal,
          onProgress: () => undefined,
        },
        task: "Review until interrupted.",
        baseRevision: "abc123",
        sourceHarness: "claude",
        debugCapture: false,
        repositoryFingerprint: "unchanged",
      },
      {
        sessionStore,
        runStore,
        async runReview(input) {
          await input.onNativeSessionOpened("thread-1");

          return waitForReviewOrInterruption({
            review: new Promise<ReviewResult>(() => undefined),
            signal: input.signal,
            activeTurn: () => ({ threadId: "thread-1", turnId: "turn-1" }),
            async interrupt(turn) {
              interruptedTurn = turn;
            },
          });
        },
        readRepositoryFingerprint: async () => "unchanged",
        onTerminalStateDecided: () => cancellation.freeze(),
      },
    );

    expect((await rejectedError(review)).message).toContain("deadline");
    expect(interruptedTurn).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const saved = await runStore.latest({
      harness: "codex",
      name: "deadline-review",
    });
    expect(saved?.handoff.status).toBe("interrupted");
    expect(saved?.events.at(-1)?.type).toBe("session.interrupted");
  } finally {
    cancellation.dispose();
  }
});

test("a repository change rejects an otherwise valid verdict", async () => {
  const { repository, runStore, sessionStore } = await createRepository();
  const review = runRecordedReview(
    {
      review: {
        cwd: repository,
        sessionName: "stale-review",
        prompt: "Review changing files.",
        outputSchema: {},
        onProgress: () => undefined,
      },
      task: "Review changing files.",
      baseRevision: "abc123",
      sourceHarness: "claude",
      debugCapture: false,
      repositoryFingerprint: "before",
    },
    {
      sessionStore,
      runStore,
      async runReview() {
        return approvedReview;
      },
      readRepositoryFingerprint: async () => "after",
      onTerminalStateDecided: () => undefined,
    },
  );

  expect((await rejectedError(review)).message).toContain(
    "repository changed during the review",
  );

  const saved = await runStore.latest({
    harness: "codex",
    name: "stale-review",
  });
  expect(saved?.handoff.status).toBe("failed");
});

test("a deadline interrupts the final repository fingerprint", async () => {
  const { repository, runStore, sessionStore } = await createRepository();
  const cancellation = new RunCancellation({ timeoutSeconds: 0.01 });

  try {
    const review = runRecordedReview(
      {
        review: {
          cwd: repository,
          sessionName: "fingerprint-deadline",
          prompt: "Review the repository.",
          outputSchema: {},
          signal: cancellation.signal,
          onProgress: () => undefined,
        },
        task: "Review the repository.",
        baseRevision: "abc123",
        sourceHarness: "claude",
        debugCapture: false,
        repositoryFingerprint: "before",
      },
      {
        sessionStore,
        runStore,
        async runReview() {
          return approvedReview;
        },
        readRepositoryFingerprint: async (_repository, signal) =>
          new Promise((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("Fingerprint aborted.")),
              { once: true },
            );
          }),
        onTerminalStateDecided: () => cancellation.freeze(),
      },
    );

    expect((await rejectedError(review)).message).toContain("deadline");

    const saved = await runStore.latest({
      harness: "codex",
      name: "fingerprint-deadline",
    });
    expect(saved?.handoff.status).toBe("interrupted");
  } finally {
    cancellation.dispose();
  }
});
