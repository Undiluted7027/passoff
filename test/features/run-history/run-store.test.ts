import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReviewResult } from "../../../src/features/ask-codex/review-result.ts";
import { SessionStore } from "../../../src/features/ask-codex/session-store.ts";
import { loadLatestRun } from "../../../src/features/run-history/load-latest-run.ts";
import { runRecordedReview } from "../../../src/features/run-history/run-recorded-review.ts";
import {
  RunStore,
  type StartRunInput,
} from "../../../src/features/run-history/run-store.ts";
import { rejectedError } from "../../support/rejected-error.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function createRepository(name = "repository") {
  const root = await mkdtemp(join(tmpdir(), "passoff-run-test-"));
  const repository = join(root, name);
  const stateDirectory = join(root, "state");
  temporaryDirectories.push(root);
  await mkdir(repository, { recursive: true });

  return {
    repository,
    stateDirectory,
    store: await RunStore.forRepository(repository, stateDirectory),
  };
}

const approvedReview: ReviewResult = {
  status: "approved",
  summary: "No findings.",
  findings: [],
  checks: [],
};

function handoff(
  repository: string,
  sessionName = "auth-review",
): StartRunInput {
  return {
    task: "Review the authorization changes.",
    repository,
    baseRevision: "abc123",
    sourceHarness: "claude",
    targetHarness: "codex",
    sessionName,
    debugCapture: false,
  };
}

test("a failed run keeps its session and normalized lifecycle", async () => {
  const { repository, stateDirectory, store } = await createRepository();
  const sessionStore = await SessionStore.forRepository(
    repository,
    stateDirectory,
  );
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
    },
    {
      sessionStore,
      runStore: store,
      async runReview(input) {
        await input.onNativeSessionOpened("thread-1");
        throw new Error("Codex stopped before returning a result.");
      },
    },
  );

  expect((await rejectedError(review)).message).toContain(
    "Codex stopped before returning a result.",
  );

  const saved = await store.latest({ harness: "codex", name: "auth-review" });

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

test("an unfinished result file is never exposed as a completed run", async () => {
  const { repository, stateDirectory, store } = await createRepository();
  const run = await store.start(handoff(repository));
  const files = await readdir(stateDirectory, { recursive: true });
  const handoffPath = files.find((path) => path.endsWith("handoff.json"));

  if (!handoffPath) {
    throw new Error("The test run did not create handoff.json.");
  }

  const runDirectory = join(stateDirectory, handoffPath, "..");
  await writeFile(join(runDirectory, "result.json.unfinished.tmp"), "{", "utf8");

  const running = await store.latest({ harness: "codex", name: "auth-review" });
  expect(running?.handoff.status).toBe("running");
  expect(running?.result).toBeUndefined();

  await run.complete(approvedReview);
  const completed = await store.latest({ harness: "codex", name: "auth-review" });
  expect(completed?.handoff.status).toBe("approved");
  expect(completed?.result).toMatchObject({ status: "approved" });
});

test("latest-run lookup is isolated by repository and session name", async () => {
  const first = await createRepository("first");
  const secondRepository = join(first.repository, "..", "second");
  await mkdir(secondRepository);
  const secondStore = await RunStore.forRepository(
    secondRepository,
    first.stateDirectory,
  );

  const firstRun = await first.store.start(handoff(first.repository));
  const otherSession = await first.store.start(
    handoff(first.repository, "performance-review"),
  );
  const secondRun = await secondStore.start(handoff(secondRepository));
  await firstRun.complete({ ...approvedReview, summary: "First repository." });
  await otherSession.complete({ ...approvedReview, summary: "Other session." });
  await secondRun.complete({ ...approvedReview, summary: "Second repository." });

  const firstResult = await loadLatestRun(
    first.repository,
    "auth-review",
    first.stateDirectory,
  );
  const secondResult = await loadLatestRun(
    secondRepository,
    "auth-review",
    first.stateDirectory,
  );

  expect(firstResult.result).toMatchObject({
    review: { summary: "First repository." },
  });
  expect(secondResult.result).toMatchObject({
    review: { summary: "Second repository." },
  });
});

test("debug capture redacts secrets and bounds retained messages", async () => {
  const { repository, store } = await createRepository();
  const run = await store.start({
    ...handoff(repository),
    debugCapture: true,
  });
  run.captureProviderMessage({
    method: "example",
    params: {
      authorization: "Bearer private",
      api_key: "private",
      env: { HOME: "/Users/sanchit", TOKEN: "private" },
      message: "Kept for debugging",
    },
  });
  run.captureProviderMessage({ message: "x".repeat(100_000) });

  for (let index = 0; index < 300; index += 1) {
    run.captureProviderMessage({ sequence: index });
  }

  await run.complete(approvedReview);

  const saved = await store.latest({ harness: "codex", name: "auth-review" });
  expect(saved?.providerExcerpts?.[0]).toEqual({
    method: "example",
    params: {
      authorization: "[redacted]",
      api_key: "[redacted]",
      env: "[redacted]",
      message: "Kept for debugging",
    },
  });
  expect(JSON.stringify(saved?.providerExcerpts)).toContain("capture truncated");
  expect(JSON.stringify(saved?.providerExcerpts).length).toBeLessThan(300_000);
});
