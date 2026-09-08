import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { fingerprintRepository } from "../../../src/features/ask-codex/repository.ts";
import { rejectedError } from "../../support/rejected-error.ts";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("detects file changes and rejects dirty submodules", async () => {
  const repository = await mkdtemp(join(tmpdir(), "passoff-repository-test-"));
  const trackedFile = join(repository, "tracked.txt");
  temporaryDirectories.push(repository);

  await execFileAsync("git", ["init"], { cwd: repository });
  await writeFile(trackedFile, "original\n", "utf8");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Passoff Test",
      "-c",
      "user.email=passoff@example.invalid",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: repository },
  );

  const clean = await fingerprintRepository(repository);
  await writeFile(trackedFile, "changed\n", "utf8");
  const trackedChange = await fingerprintRepository(repository);
  await writeFile(trackedFile, "original\n", "utf8");
  await writeFile(join(repository, "untracked.txt"), "first\n", "utf8");
  const untrackedFile = await fingerprintRepository(repository);
  await writeFile(join(repository, "untracked.txt"), "second\n", "utf8");
  const changedUntrackedFile = await fingerprintRepository(repository);

  expect(trackedChange).not.toBe(clean);
  expect(untrackedFile).not.toBe(clean);
  expect(changedUntrackedFile).not.toBe(untrackedFile);

  const submoduleSource = await mkdtemp(join(tmpdir(), "passoff-submodule-test-"));
  temporaryDirectories.push(submoduleSource);
  await execFileAsync("git", ["init"], { cwd: submoduleSource });
  await writeFile(join(submoduleSource, "source.txt"), "original\n", "utf8");
  await execFileAsync("git", ["add", "source.txt"], { cwd: submoduleSource });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Passoff Test",
      "-c",
      "user.email=passoff@example.invalid",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: submoduleSource },
  );
  await execFileAsync(
    "git",
    [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submoduleSource,
      "dependency",
    ],
    { cwd: repository },
  );
  const cleanSubmodule = await fingerprintRepository(repository);
  await execFileAsync(
    "git",
    ["config", "submodule.dependency.ignore", "all"],
    { cwd: repository },
  );
  await writeFile(join(repository, "dependency", "source.txt"), "changed\n", "utf8");
  await execFileAsync("git", ["-C", "dependency", "add", "source.txt"], {
    cwd: repository,
  });
  await execFileAsync(
    "git",
    [
      "-C",
      "dependency",
      "-c",
      "user.name=Passoff Test",
      "-c",
      "user.email=passoff@example.invalid",
      "commit",
      "-m",
      "new dependency revision",
    ],
    { cwd: repository },
  );
  const changedSubmoduleHead = await fingerprintRepository(repository);

  expect(changedSubmoduleHead).not.toBe(cleanSubmodule);

  await writeFile(
    join(repository, "dependency", "source.txt"),
    "dirty again\n",
    "utf8",
  );

  expect(
    (await rejectedError(fingerprintRepository(repository))).message,
  ).toContain("submodules have no uncommitted changes");
});
