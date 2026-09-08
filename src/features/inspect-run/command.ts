import { parseArgs } from "node:util";
import { defineCommand } from "citty";

import { resolveRepositoryRoot } from "../ask-codex/repository.ts";
import { loadLatestRun } from "../run-history/load-latest-run.ts";
import type { StoredRun } from "../run-history/run-record.ts";

export const inspectCommand = defineCommand({
  meta: {
    name: "inspect",
    description: "Inspect the latest run in a named session.",
  },
  args: {
    session: {
      type: "string",
      description: "Named Codex session",
      required: true,
    },
    json: {
      type: "boolean",
      description: "Write the complete run record as JSON",
      default: false,
    },
  },
  async run({ args, rawArgs }) {
    try {
      assertSupportedArguments(rawArgs);
      const sessionName = args.session.trim();

      if (sessionName === "") {
        throw new Error("The session name cannot be empty.");
      }

      const repository = await resolveRepositoryRoot(process.cwd());
      const run = await loadLatestRun(repository, sessionName);
      const output = args.json ? JSON.stringify(run) : formatRun(run);
      process.stdout.write(`${output}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Passoff failed.";
      process.stderr.write(`passoff: ${message}\n`);
      process.exitCode = 1;
    }
  },
});

function assertSupportedArguments(rawArgs: string[]): void {
  parseArgs({
    args: rawArgs,
    allowPositionals: false,
    strict: true,
    options: {
      session: { type: "string" },
      json: { type: "boolean" },
    },
  });
}

function formatRun(run: StoredRun): string {
  const { handoff, result } = run;
  const lines = [
    `Run: ${handoff.runId}`,
    `Status: ${handoff.status}`,
    `Source: ${handoff.sourceHarness ?? "unknown"}`,
    `Target: ${handoff.targetHarness}`,
    `Session: ${handoff.sessionName ?? "unnamed"}`,
    `Native session: ${handoff.nativeSessionId ?? "not opened"}`,
    `Started: ${handoff.startedAt}`,
    `Finished: ${handoff.finishedAt ?? "still running"}`,
    `Task: ${handoff.task}`,
  ];

  if (result && "review" in result) {
    lines.push(`Summary: ${result.review.summary}`);
  } else if (result) {
    lines.push(`Failure: ${result.failureReason}`);
  }

  lines.push(`Events: ${run.events.length}`);
  return lines.join("\n");
}
