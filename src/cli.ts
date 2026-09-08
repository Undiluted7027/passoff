#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: {
    name: "passoff",
    version: "0.0.0",
    description: "Give bounded tasks to another coding harness.",
  },
  subCommands: {
    // Help and version output should not load a provider adapter or touch local state.
    ask: () =>
      import("./features/ask-codex/command.ts").then(
        ({ askCommand }) => askCommand,
      ),
    inspect: () =>
      import("./features/inspect-run/command.ts").then(
        ({ inspectCommand }) => inspectCommand,
      ),
  },
});

await runMain(main);
