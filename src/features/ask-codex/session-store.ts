import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const sessionFileSchema = z.strictObject({
  version: z.literal(1),
  harness: z.string().min(1),
  name: z.string().min(1),
  nativeSessionId: z.string().min(1),
});

type SessionFile = z.infer<typeof sessionFileSchema>;
type SessionKey = Pick<SessionFile, "harness" | "name">;

/**
 * Stores one opaque session ID per file under the repository's state folder.
 * Separate files let different session names update without sharing a lock.
 */
export class SessionStore {
  private constructor(private readonly directory: string) {}

  static async forRepository(
    repositoryRoot: string,
    stateDirectory = passoffStateDirectory(),
  ): Promise<SessionStore> {
    // The same checkout may be reached through a symlink. Canonicalizing first
    // keeps those paths attached to one session directory.
    const canonicalRoot = await realpath(repositoryRoot);
    const repositoryKey = hash(canonicalRoot);

    return new SessionStore(
      join(stateDirectory, "projects", repositoryKey, "sessions"),
    );
  }

  async get(key: SessionKey): Promise<string | undefined> {
    const filePath = this.filePath(key);

    try {
      const text = await readFile(filePath, "utf8");
      const session = sessionFileSchema.parse(JSON.parse(text));

      // The record is authoritative; the hashed filename is only a safe lookup.
      if (session.harness !== key.harness || session.name !== key.name) {
        throw new Error(`Passoff session key does not match its file: ${filePath}`);
      }

      return session.nativeSessionId;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return undefined;
      }

      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new Error(`Passoff session state is invalid: ${filePath}`);
      }

      throw error;
    }
  }

  async set(key: SessionKey, nativeSessionId: string): Promise<void> {
    const file: SessionFile = { version: 1, ...key, nativeSessionId };
    const filePath = this.filePath(key);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

    await mkdir(this.directory, { recursive: true, mode: 0o700 });

    try {
      await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      // Each key owns one file. Atomic replacement cannot drop other sessions.
      await rename(temporaryPath, filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private filePath(key: SessionKey): string {
    // Names are kept inside the validated JSON record. Hashing keeps arbitrary
    // user input out of filesystem paths and includes the harness in the key.
    return join(this.directory, `${hash(JSON.stringify(key))}.json`);
  }
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

function hasErrorCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
