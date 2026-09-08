import { spawn } from "node:child_process";

import { readJsonLines } from "../codex/json-lines.ts";

export type ClaudeProcess = {
  readonly messages: AsyncIterable<unknown>;
  interrupt(): void;
  close(): Promise<void>;
};

/** Starts Claude on the host so it can use its own installed authentication. */
export function createClaudeProcess(
  cwd: string,
  args: string[],
  onProgress: (text: string) => void,
): ClaudeProcess {
  const child = spawn("claude", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => onProgress(text));

  let spawnError: Error | undefined;
  let closing: Promise<void> | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });

  async function* messages(): AsyncGenerator<unknown> {
    yield* readJsonLines(child.stdout, "Claude Code");

    if (spawnError) {
      throw new Error(
        `Could not start Claude Code. Is it installed and available on PATH? ${spawnError.message}`,
      );
    }
  }

  return {
    messages: messages(),
    interrupt() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGINT");
      }

      // Claude can ignore or delay SIGINT while a tool is active. Start the
      // bounded shutdown here so cancellation cannot wait forever on stdout.
      closing ??= ensureExit();
    },
    close() {
      closing ??= ensureExit("SIGTERM");
      return closing;
    },
  };

  async function ensureExit(signal?: NodeJS.Signals): Promise<void> {
    if (signal && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }

    if (!(await waitForExit(1_000))) {
      child.kill("SIGKILL");
      await waitForExit(1_000);
    }
  }

  async function waitForExit(timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return true;
    }

    return new Promise((resolve) => {
      const onClose = () => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);

      function finish(exited: boolean): void {
        clearTimeout(timeout);
        child.off("close", onClose);
        resolve(exited);
      }

      child.once("close", onClose);
    });
  }
}
