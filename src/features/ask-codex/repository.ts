import { execFile, spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { throwIfInterrupted } from "../../harnesses/harness-interruption.ts";

const execFileAsync = promisify(execFile);

export type ReviewRepository = {
  root: string;
  baseRevision: string;
};

async function runGit(
  cwd: string,
  args: string[],
  failureMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await runGitOutput(cwd, args, failureMessage, signal)).trim();
}

export async function resolveReviewRepository(
  cwd: string,
  base: string,
): Promise<ReviewRepository> {
  const root = await resolveRepositoryRoot(cwd);
  const baseRevision = await runGit(
    root,
    ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
    `Base revision ${JSON.stringify(base)} does not resolve to a commit.`,
  );

  return { root, baseRevision };
}

export async function resolveRepositoryRoot(cwd: string): Promise<string> {
  return runGit(
    cwd,
    ["rev-parse", "--show-toplevel"],
    "The current directory is not inside a Git repository.",
  );
}

/** Fingerprints the reviewed commit, tracked changes, and untracked file contents. */
export async function fingerprintRepository(
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfInterrupted(signal);
  await assertSubmodulesClean(root, signal);
  const hash = createHash("sha256");
  const head = await runGit(
    root,
    ["rev-parse", "HEAD"],
    "Could not read the repository HEAD.",
    signal,
  );
  const untrackedOutput = await runGitOutput(
    root,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "Could not list untracked repository files.",
    signal,
  );
  const submoduleHeads = await runGitOutput(
    root,
    [
      "submodule",
      "foreach",
      "--quiet",
      "--recursive",
      `printf '%s\\0%s\\0' "$displaypath" "$(git rev-parse HEAD)"`,
    ],
    "Could not read initialized submodule revisions.",
    signal,
  );

  hash.update("head\0").update(head).update("\0tracked\0");
  await hashGitOutput(
    hash,
    root,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      "--binary",
      "HEAD",
      "--",
    ],
    "Could not read tracked repository changes.",
    signal,
  );
  hash.update("\0submodules\0").update(submoduleHeads);

  const untrackedPaths = untrackedOutput.split("\0").filter(Boolean);

  for (const relativePath of untrackedPaths) {
    throwIfInterrupted(signal);
    const filePath = join(root, relativePath);
    const stats = await lstat(filePath);
    hash.update("\0untracked\0").update(relativePath).update("\0");

    if (stats.isSymbolicLink()) {
      hash.update("symlink\0").update(await readlink(filePath));
      continue;
    }

    hash.update("file\0");

    for await (const chunk of createReadStream(filePath, { signal })) {
      hash.update(chunk);
    }
  }

  return hash.digest("hex");
}

async function assertSubmodulesClean(
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await execFileAsync(
      "git",
      [
        "submodule",
        "foreach",
        "--quiet",
        "--recursive",
        'git diff --quiet --ignore-submodules=none HEAD -- && git diff --cached --quiet --ignore-submodules=none HEAD -- && test -z "$(git ls-files --others --exclude-standard)"',
      ],
      { cwd: root, encoding: "utf8", signal },
    );
  } catch (error) {
    throwIfInterrupted(signal);
    throw new Error(
      "Passoff could not verify submodule state. Ensure initialized submodules have no uncommitted changes.",
      { cause: error },
    );
  }
}

async function hashGitOutput(
  hash: Hash,
  cwd: string,
  args: string[],
  failureMessage: string,
  signal?: AbortSignal,
): Promise<void> {
  const child = spawn("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    signal,
  });
  await new Promise<void>((resolve, reject) => {
    const fail = () => reject(new Error(failureMessage));
    child.stdout.on("data", (chunk: Buffer) => {
      hash.update(chunk);
    });
    child.stdout.once("error", fail);
    child.once("error", fail);
    child.once("close", (code) => (code === 0 ? resolve() : fail()));
  });
}


async function runGitOutput(
  cwd: string,
  args: string[],
  failureMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      signal,
    });

    return stdout;
  } catch (error) {
    throwIfInterrupted(signal);
    throw new Error(failureMessage, { cause: error });
  }
}
