import { spawn } from "node:child_process";

import { readJsonLines } from "./json-lines.ts";
import type { RpcTransport } from "./json-rpc-connection.ts";

export function createCodexProcessTransport(
  cwd: string,
  onProgress: (text: string) => void,
): RpcTransport {
  const child = spawn("codex", ["app-server", "--stdio"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Provider diagnostics are progress. Keeping them on stderr preserves stdout
  // for the single machine-readable result promised by the CLI.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => onProgress(text));

  let spawnError: Error | undefined;
  let stdinError: Error | undefined;
  const started = new Promise<Error | undefined>((resolve) => {
    child.once("spawn", () => resolve(undefined));
    child.once("error", (error) => resolve(error));
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stdin.on("error", (error) => {
    stdinError = error;
  });

  async function* messages(): AsyncGenerator<unknown> {
    yield* readJsonLines(child.stdout);

    if (spawnError) {
      throw new Error(`Could not start Codex: ${spawnError.message}`);
    }
  }

  return {
    messages: messages(),
    async send(message) {
      const startError = await started;

      if (startError) {
        throw new Error(
          `Could not start Codex. Is it installed and available on PATH? ${startError.message}`,
        );
      }

      if (stdinError) {
        throw new Error(`Could not write to Codex: ${stdinError.message}`);
      }

      const line = `${JSON.stringify(message)}\n`;

      await new Promise<void>((resolve, reject) => {
        child.stdin.write(line, (error) => {
          if (error) {
            reject(new Error(`Could not write to Codex: ${error.message}`));
          } else {
            resolve();
          }
        });
      });
    },
    async close() {
      child.stdin.end();

      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }

      // A stuck provider must not keep a completed or failed Passoff run alive.
      if (!(await waitForExit(child, 1_000))) {
        child.kill("SIGKILL");
        await waitForExit(child, 1_000);
      }
    },
  };
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return new Promise((resolve) => {
    const onClose = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);

    function finish(exited: boolean) {
      clearTimeout(timeout);
      child.off("close", onClose);
      resolve(exited);
    }

    child.once("close", onClose);
  });
}
