import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ReviewRepository = {
  root: string;
  baseRevision: string;
};

async function runGit(
  cwd: string,
  args: string[],
  failureMessage: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
    });

    return stdout.trim();
  } catch {
    throw new Error(failureMessage);
  }
}

export async function resolveReviewRepository(
  cwd: string,
  base: string,
): Promise<ReviewRepository> {
  const root = await runGit(
    cwd,
    ["rev-parse", "--show-toplevel"],
    "The current directory is not inside a Git repository.",
  );
  const baseRevision = await runGit(
    root,
    ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
    `Base revision ${JSON.stringify(base)} does not resolve to a commit.`,
  );

  return { root, baseRevision };
}
