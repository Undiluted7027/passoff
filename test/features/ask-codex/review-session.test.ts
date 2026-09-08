import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodexReviewInput } from "../../../src/harnesses/codex/codex-adapter.ts";
import type { ReviewResult } from "../../../src/features/ask-codex/review-result.ts";
import {
  runReviewSession,
  type ReviewSessionInput,
} from "../../../src/features/ask-codex/review-session.ts";
import { SessionStore } from "../../../src/features/ask-codex/session-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function createTestRepository(name = "repository") {
  const root = await mkdtemp(join(tmpdir(), "passoff-session-test-"));
  const repository = join(root, name);
  const stateDirectory = join(root, "state");
  temporaryDirectories.push(root);
  await mkdir(repository, { recursive: true });

  return {
    repository,
    stateDirectory,
    store: await SessionStore.forRepository(repository, stateDirectory),
  };
}

const approvedReview: ReviewResult = {
  status: "approved",
  summary: "No findings.",
  findings: [],
  checks: [],
};

function reviewInput(cwd: string, sessionName: string): ReviewSessionInput {
  return {
    cwd,
    sessionName,
    prompt: "Check the fixes.",
    outputSchema: {},
    onProgress: () => undefined,
  };
}

test("the second call receives the stored native thread ID", async () => {
  const { repository, store } = await createTestRepository();
  const receivedIds: Array<string | undefined> = [];
  const runReview = async (
    input: CodexReviewInput,
  ): Promise<ReviewResult> => {
    receivedIds.push(input.nativeSessionId);
    await input.onNativeSessionOpened(input.nativeSessionId ?? "thread-1");

    return approvedReview;
  };

  await runReviewSession(reviewInput(repository, "auth-review"), {
    sessionStore: store,
    runReview,
  });
  await runReviewSession(reviewInput(repository, "auth-review"), {
    sessionStore: store,
    runReview,
  });

  expect(receivedIds).toEqual([undefined, "thread-1"]);
});

test("the same session name is isolated between repositories", async () => {
  const first = await createTestRepository("first-repository");
  const secondRepository = join(first.repository, "..", "second-repository");
  await mkdir(secondRepository);
  const secondStore = await SessionStore.forRepository(
    secondRepository,
    first.stateDirectory,
  );

  await first.store.set(
    { harness: "codex", name: "review" },
    "first-thread",
  );
  await first.store.set(
    { harness: "claude", name: "review" },
    "claude-thread",
  );
  await secondStore.set(
    { harness: "codex", name: "review" },
    "second-thread",
  );

  expect(await first.store.get({ harness: "codex", name: "review" })).toBe(
    "first-thread",
  );
  expect(await secondStore.get({ harness: "codex", name: "review" })).toBe(
    "second-thread",
  );
  expect(await first.store.get({ harness: "claude", name: "review" })).toBe(
    "claude-thread",
  );

  const stateFiles = await readdir(first.stateDirectory, { recursive: true });
  expect(stateFiles.filter((path) => path.endsWith(".json"))).toHaveLength(3);
  expect(stateFiles.some((path) => path.endsWith(".tmp"))).toBe(false);
});

test("failures preserve the last native thread ID that opened", async () => {
  const { repository, store } = await createTestRepository();
  const key = { harness: "codex", name: "review" };
  await store.set(key, "working-thread");

  const failedResume = runReviewSession(reviewInput(repository, "review"), {
    sessionStore: store,
    async runReview() {
      throw new Error("Native session missing");
    },
  });

  expect(failedResume).rejects.toThrow("Native session missing");
  expect(await store.get(key)).toBe("working-thread");

  const firstTurnKey = { harness: "codex", name: "first-turn" };
  const failedFirstTurn = runReviewSession(
    reviewInput(repository, "first-turn"),
    {
      sessionStore: store,
      async runReview(input) {
        await input.onNativeSessionOpened("new-thread");
        throw new Error("Turn failed after opening");
      },
    },
  );

  expect(failedFirstTurn).rejects.toThrow("Turn failed after opening");
  expect(await store.get(firstTurnKey)).toBe("new-thread");
});

test("concurrent saves keep every session mapping", async () => {
  const { repository, stateDirectory } = await createTestRepository();
  const firstStore = await SessionStore.forRepository(
    repository,
    stateDirectory,
  );
  const secondStore = await SessionStore.forRepository(
    repository,
    stateDirectory,
  );

  await Promise.all([
    firstStore.set(
      { harness: "codex", name: "security-review" },
      "thread-1",
    ),
    secondStore.set(
      { harness: "codex", name: "types-review" },
      "thread-2",
    ),
  ]);

  expect(
    await firstStore.get({ harness: "codex", name: "security-review" }),
  ).toBe("thread-1");
  expect(
    await firstStore.get({ harness: "codex", name: "types-review" }),
  ).toBe("thread-2");

  const stateFiles = await readdir(stateDirectory, { recursive: true });
  expect(stateFiles.some((path) => path.endsWith(".tmp"))).toBe(false);
});
