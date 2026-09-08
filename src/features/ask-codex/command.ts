import { parseArgs } from "node:util";
import { defineCommand } from "citty";

import { runCodexReview } from "../../harnesses/codex/codex-adapter.ts";
import { buildReviewPrompt, reviewOutputSchema } from "./review-prompt.ts";
import {
  fingerprintRepository,
  resolveReviewRepository,
} from "./repository.ts";
import {
  parseTimeoutSeconds,
  RunCancellation,
} from "./run-cancellation.ts";
import { isHandoffInterruptedError } from "../../harnesses/harness-interruption.ts";
import { SessionStore } from "./session-store.ts";
import { runRecordedReview } from "../run-history/run-recorded-review.ts";
import { RunStore } from "../run-history/run-store.ts";

export const askCommand = defineCommand({
  meta: {
    name: "ask",
    description: "Give a bounded task to another coding harness.",
  },
  args: {
    harness: {
      type: "positional",
      description: "Target coding harness",
      required: true,
    },
    task: {
      type: "positional",
      description: "Review task",
      required: true,
    },
    base: {
      type: "string",
      description: "Git revision to compare against",
      default: "HEAD",
    },
    role: {
      type: "enum",
      description: "Role assigned to the target harness",
      options: ["reviewer"],
      default: "reviewer",
    },
    model: {
      type: "string",
      description: "Codex model; defaults to the app-server catalog default",
    },
    source: {
      type: "enum",
      description: "Harness making the request",
      options: ["claude", "codex"],
    },
    session: {
      type: "string",
      description: "Name used to resume the same Codex thread",
    },
    "debug-capture": {
      type: "boolean",
      description: "Save sanitized Codex protocol messages with the run",
      default: false,
    },
    timeout: {
      type: "string",
      description: "Stop the review after this many seconds",
    },
  },
  async run({ args, rawArgs }) {
    try {
      assertSupportedArguments(rawArgs);

      if (args.harness !== "codex") {
        throw new Error(`Unsupported harness: ${args.harness}`);
      }

      if (args.task.trim() === "") {
        throw new Error("The review task cannot be empty.");
      }

      const repository = await resolveReviewRepository(process.cwd(), args.base);
      const sessionName = args.session?.trim();
      const timeoutSeconds = parseTimeoutSeconds(args.timeout);

      if (args.session !== undefined && sessionName === "") {
        throw new Error("The session name cannot be empty.");
      }

      const sessionStore = await SessionStore.forRepository(repository.root);
      const runStore = await RunStore.forRepository(repository.root);
      const repositoryFingerprint = await fingerprintRepository(repository.root);
      const cancellation = new RunCancellation({ timeoutSeconds });

      try {
        const result = await runRecordedReview(
          {
            task: args.task,
            baseRevision: repository.baseRevision,
            sourceHarness: args.source,
            debugCapture: args["debug-capture"],
            repositoryFingerprint,
            review: {
              cwd: repository.root,
              prompt: buildReviewPrompt({
                task: args.task,
                repository: repository.root,
                baseRevision: repository.baseRevision,
              }),
              outputSchema: reviewOutputSchema,
              model: args.model,
              sessionName,
              signal: cancellation.signal,
              onProgress: (text) => process.stderr.write(text),
            },
          },
          {
            sessionStore,
            runStore,
            runReview: runCodexReview,
            readRepositoryFingerprint: fingerprintRepository,
            onTerminalStateDecided: () => cancellation.freeze(),
          },
        );

        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally {
        cancellation.dispose();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Passoff failed.";
      process.stderr.write(`passoff: ${message}\n`);
      process.exitCode = isHandoffInterruptedError(error) ? error.exitCode : 1;
    }
  },
});

function assertSupportedArguments(rawArgs: string[]): void {
  // Citty 0.2 parses unknown options permissively. Validate the raw input again
  // so a future option such as --session cannot be mistaken for the task.
  const parsed = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    strict: true,
    options: {
      base: { type: "string" },
      role: { type: "string" },
      model: { type: "string" },
      source: { type: "string" },
      session: { type: "string" },
      "debug-capture": { type: "boolean" },
      timeout: { type: "string" },
    },
  });

  if (parsed.positionals.length !== 2) {
    throw new Error("Expected exactly a harness and one quoted task.");
  }
}
