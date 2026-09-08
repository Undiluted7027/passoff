import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export async function repositoryStateDirectory(
  repositoryRoot: string,
  stateDirectory = passoffStateDirectory(),
): Promise<string> {
  // Symlinked paths to one checkout must share sessions and run history.
  const canonicalRoot = await realpath(repositoryRoot);
  return join(stateDirectory, "projects", hash(canonicalRoot));
}

export function sessionStateKey(key: {
  harness: string;
  name: string;
}): string {
  // Property order is explicit because this hash locates existing state files.
  return hash(JSON.stringify({ harness: key.harness, name: key.name }));
}

/** Replaces a complete file in one rename so readers never see half a write. */
export async function writeTextAtomically(
  filePath: string,
  text: string,
): Promise<void> {
  const directory = dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  await mkdir(directory, { recursive: true, mode: 0o700 });

  try {
    await writeFile(temporaryPath, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function writeJsonAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeTextAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function hasErrorCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function passoffStateDirectory(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "passoff");
  }

  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "passoff",
    );
  }

  return join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "passoff",
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
