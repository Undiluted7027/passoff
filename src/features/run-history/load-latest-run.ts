import { RunStore } from "./run-store.ts";
import type { StoredRun } from "./run-record.ts";

export async function loadLatestRun(
  repositoryRoot: string,
  sessionName: string,
  stateDirectory?: string,
): Promise<StoredRun> {
  const store = await RunStore.forRepository(repositoryRoot, stateDirectory);
  const run = await store.latest({ harness: "codex", name: sessionName });

  if (!run) {
    throw new Error(
      `No Codex run was found for session ${JSON.stringify(sessionName)} in this repository.`,
    );
  }

  return run;
}
