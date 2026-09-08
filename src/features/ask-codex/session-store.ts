import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  hasErrorCode,
  repositoryStateDirectory,
  sessionStateKey,
  writeJsonAtomically,
} from "../local-state/repository-state.ts";

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
    stateDirectory?: string,
  ): Promise<SessionStore> {
    const projectDirectory = await repositoryStateDirectory(
      repositoryRoot,
      stateDirectory,
    );
    return new SessionStore(join(projectDirectory, "sessions"));
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

    // Each key owns one file. Atomic replacement cannot drop other sessions.
    await writeJsonAtomically(filePath, file);
  }

  /** Removes a mapping only when it still points to the unsafe native session. */
  async delete(key: SessionKey, nativeSessionId: string): Promise<void> {
    if ((await this.get(key)) !== nativeSessionId) {
      return;
    }

    await rm(this.filePath(key), { force: true });
  }

  private filePath(key: SessionKey): string {
    // Names are kept inside the validated JSON record. Hashing keeps arbitrary
    // user input out of filesystem paths and includes the harness in the key.
    return join(this.directory, `${sessionStateKey(key)}.json`);
  }
}
