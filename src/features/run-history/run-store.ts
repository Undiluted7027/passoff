import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  hasErrorCode,
  repositoryStateDirectory,
  sessionStateKey,
  writeJsonAtomically,
} from "../local-state/repository-state.ts";
import { ActiveRun } from "./active-run.ts";
import {
  harnessIdSchema,
  handoffFileSchema,
  type HarnessId,
  type RunEvent,
  runEventSchema,
  runResultFileSchema,
  type StoredRun,
} from "./run-record.ts";

const latestRunFileSchema = z.strictObject({
  version: z.literal(1),
  harness: harnessIdSchema,
  name: z.string().min(1),
  runId: z.uuid(),
});

type SessionKey = Pick<
  z.infer<typeof latestRunFileSchema>,
  "harness" | "name"
>;

export type StartRunInput = {
  task: string;
  repository: string;
  baseRevision: string;
  sourceHarness?: HarnessId;
  targetHarness: HarnessId;
  sessionName?: string;
  debugCapture: boolean;
};

/** Stores durable run artifacts and a small pointer for latest-session lookup. */
export class RunStore {
  private constructor(private readonly projectDirectory: string) {}

  static async forRepository(
    repositoryRoot: string,
    stateDirectory?: string,
  ): Promise<RunStore> {
    return new RunStore(
      await repositoryStateDirectory(repositoryRoot, stateDirectory),
    );
  }

  async start(input: StartRunInput): Promise<ActiveRun> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const handoff = handoffFileSchema.parse({
      version: 1,
      runId,
      task: input.task,
      repository: input.repository,
      baseRevision: input.baseRevision,
      sourceHarness: input.sourceHarness ?? null,
      targetHarness: input.targetHarness,
      sessionName: input.sessionName ?? null,
      nativeSessionId: null,
      startedAt,
      finishedAt: null,
      status: "running",
      failureReason: null,
    });
    const events: RunEvent[] = [{ type: "handoff.started", timestamp: startedAt }];
    const run = await ActiveRun.create(
      join(this.projectDirectory, "runs", runId),
      handoff,
      events,
      input.debugCapture,
    );

    if (input.sessionName) {
      const key = { harness: input.targetHarness, name: input.sessionName };
      await writeJsonAtomically(this.latestRunPath(key), {
        version: 1,
        ...key,
        runId,
      });
    }

    return run;
  }

  async latest(key: SessionKey): Promise<StoredRun | undefined> {
    const pointer = await readOptionalJson(
      this.latestRunPath(key),
      latestRunFileSchema,
    );

    if (!pointer) {
      return undefined;
    }

    if (pointer.harness !== key.harness || pointer.name !== key.name) {
      throw new Error("Passoff latest-run pointer does not match its session.");
    }

    const runDirectory = join(this.projectDirectory, "runs", pointer.runId);
    const handoff = await readRequiredJson(
      join(runDirectory, "handoff.json"),
      handoffFileSchema,
    );
    const events = await readEvents(join(runDirectory, "events.ndjson"));

    if (handoff.runId !== pointer.runId) {
      throw new Error("Passoff run record does not match its latest-run pointer.");
    }

    // The handoff is marked terminal last. Until then, an orphaned staging or
    // result file cannot make inspect report a run as complete.
    if (handoff.status === "running") {
      return { handoff, events };
    }

    const result = await readRequiredJson(
      join(runDirectory, "result.json"),
      runResultFileSchema,
    );

    if (result.runId !== handoff.runId || result.status !== handoff.status) {
      throw new Error("Passoff result does not match its handoff record.");
    }

    const providerExcerpts = await readOptionalJson(
      join(runDirectory, "provider.json"),
      z.array(z.json()),
    );

    return {
      handoff,
      events,
      result,
      ...(providerExcerpts ? { providerExcerpts } : {}),
    };
  }

  private latestRunPath(key: SessionKey): string {
    return join(
      this.projectDirectory,
      "run-index",
      `${sessionStateKey(key)}.json`,
    );
  }
}

async function readEvents(filePath: string): Promise<RunEvent[]> {
  try {
    const text = await readFile(filePath, "utf8");

    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => runEventSchema.parse(JSON.parse(line)));
  } catch (error) {
    throw new Error(`Passoff run state is invalid: ${filePath}`, { cause: error });
  }
}

async function readRequiredJson<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    throw new Error(`Passoff run state is invalid: ${filePath}`, { cause: error });
  }
}

async function readOptionalJson<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    throw new Error(`Passoff run state is invalid: ${filePath}`, { cause: error });
  }
}
