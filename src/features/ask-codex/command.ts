import { parseArgs } from "node:util";
import { defineCommand } from "citty";

import { startCodexReview } from "../../harnesses/codex/codex-adapter.ts";
import { buildReviewPrompt, reviewOutputSchema } from "./review-prompt.ts";
import { resolveReviewRepository } from "./repository.ts";

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
      const result = await startCodexReview({
        cwd: repository.root,
        prompt: buildReviewPrompt({
          task: args.task,
          repository: repository.root,
          baseRevision: repository.baseRevision,
        }),
        outputSchema: reviewOutputSchema,
        model: args.model,
        onProgress: (text) => process.stderr.write(text),
      });

      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Passoff failed.";
      process.stderr.write(`passoff: ${message}\n`);
      process.exitCode = 1;
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
    },
  });

  if (parsed.positionals.length !== 2) {
    throw new Error("Expected exactly a harness and one quoted task.");
  }
}
