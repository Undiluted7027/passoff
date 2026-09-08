# Passoff proof of concept

## What we are building

Passoff lets one coding agent give another a bounded task and get an answer back. Each agent stays in its native harness and keeps its own session, tools, prompts, permissions, and context management.

The POC connects Claude Code and Codex on the user's machine. It drives their installed CLIs using the authentication they already have. Passoff does not call model APIs, copy entire chat histories, or try to become another coding harness.

Passoff sends the task and repository reference, not the source agent's transcript.

## The demo

The first demo starts in Claude Code. Claude implements a feature, asks Codex to review it, fixes the findings, then asks the same Codex session to check the result.

1. The user asks Claude Code to implement a small feature and have Codex review it.
2. Claude Code runs `passoff ask codex --role reviewer`.
3. Passoff starts a Codex thread in the same repository and gives it a focused review task.
4. Codex reads the code and current diff, then reports its findings.
5. Claude Code fixes the problems.
6. Claude Code calls Passoff again with the same named Codex session.
7. Codex resumes its thread and checks the fixes.
8. Codex returns its verdict.

The loop requires no copying between terminals, and both native sessions remain usable afterward. Until this works reliably, there is no reason to build the rest of Passoff.

## Boundaries

A handoff tells the target what to do and where to work. The target reads the repository and builds its own context. Passoff does not stuff one model's transcript into another.

The POC runs locally and leaves authentication to each harness:

- Users install and authenticate their own harnesses.
- Each harness chooses its configured authentication method.
- Passoff never reads, stores, proxies, or implements provider credentials.
- Native session IDs are opaque strings to Passoff.
- Hosted execution and account management can wait.

## Scope

The POC includes Claude Code and Codex adapters, one `passoff ask` command, resumable target sessions, a read-only reviewer role, structured results, local run records, and instructions for invoking Passoff from either harness.

We are not building these yet:

- A generic model API.
- Conversation-history conversion.
- Concurrent editing.
- Automatic merging or conflict resolution.
- Hosted agents, mobile clients, accounts, or billing.
- A workflow builder.
- Agents that delegate without a user request or project instruction.

## CLI

The main command is:

```bash
passoff ask <harness> [options] <task>
```

For example:

```bash
passoff ask codex \
  --source claude \
  --role reviewer \
  --session auth-review \
  --timeout 300 \
  "Review the current diff for authorization bugs"
```

Use the same session name for a follow-up:

```bash
passoff ask codex \
  --session auth-review \
  "Verify the fixes"
```

Progress goes to stderr. The final machine-readable result goes to stdout so scripts and parent agents can consume it without parsing progress logs.

`--timeout` sets a deadline in seconds. Pressing Ctrl-C, receiving `SIGTERM`, or reaching the deadline interrupts the active native turn and records the run as interrupted before Passoff exits.

Inspect the latest run in a named Codex session:

```bash
passoff inspect --session auth-review
passoff inspect --session auth-review --json
```

The default output is short and readable. `--json` returns the complete stored record. Add `passoff list` or `passoff interrupt` when the demo needs them.

## Handoff format

The shared type describes the job, its source, and its target. Provider details stay inside the adapters.

```ts
type HarnessId = "claude" | "codex";

type Delegation = {
  task: string;
  role: "reviewer";
  cwd: string;
  revision?: string;
  source: {
    harness: HarnessId;
    sessionId?: string;
  };
  target: {
    harness: HarnessId;
    sessionId?: string;
  };
  expectedResult?: string;
};
```

The target prompt contains the objective, role, working directory, current Git revision when available, and result format. It tells the target to inspect the repository. It does not include the source agent's full conversation.

## Harness adapters

Adapters share lifecycle operations but keep native behavior intact.

```ts
type HarnessCapabilities = {
  resume: boolean;
  interrupt: boolean;
  structuredOutput: boolean;
  approvals: boolean;
  worktrees: boolean;
};

type HarnessRun = {
  events: AsyncIterable<HarnessEvent>;
  interrupt(): Promise<void>;
};

interface HarnessAdapter {
  readonly id: HarnessId;
  readonly capabilities: HarnessCapabilities;

  start(input: StartInput): Promise<HarnessRun>;
  resume(input: ResumeInput): Promise<HarnessRun>;
}
```

Each run owns the handle needed to interrupt it. For Codex, that is a thread and turn pair. For Claude, it is a live process. A session ID identifies resumable history, not the active work to cancel. Let the first adapter tests drive the input types instead of adding fields for hypothetical uses.

## Events

Passoff needs a small common event vocabulary:

```ts
type HarnessEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "message.delta"; text: string }
  | { type: "tool.started"; name: string }
  | { type: "tool.completed"; name: string }
  | { type: "approval.required"; method: string }
  | { type: "session.completed"; status: "approved" | "changes_requested" | "blocked" }
  | { type: "session.failed"; message: string }
  | { type: "session.interrupted"; message: string };
```

The POC does not need a larger public event model. Keep raw provider events in memory while parsing them, and persist sanitized excerpts only when debug logging is enabled.

## Codex integration

Run the installed `codex app-server` and use its documented JSON-RPC transport. Generate TypeScript definitions from the installed CLI when practical instead of maintaining guessed protocol types.

The adapter initializes the server and checks the configured or default model against `model/list`. It starts or resumes a thread, runs a turn, translates the events Passoff uses, and interrupts active turns. Approval requests go back to the caller; the adapter never approves them. Only a completed `agentMessage` with the `final_answer` phase counts as the result because Codex can also emit commentary messages during structured runs.

A Codex agent in the read-only sandbox cannot reliably start Claude Code as a shell child because the child cannot access Claude's native login. Codex-to-Claude handoffs therefore use a narrow Passoff dynamic tool. The Passoff host receives the call and starts Claude under Claude's own restrictions. Dynamic tools currently require the app-server client's `experimentalApi` capability, so this behavior stays inside the Codex adapter and needs fixture coverage.

## Claude Code integration

Start with the installed Claude Code CLI in print mode with structured streaming. Capture its session ID and pass that ID to `--resume` for follow-ups.

Use `--restricted --strict-mcp-config` and an explicit tool list for reviewer runs. Restrictions must be supplied again on resume; a resumed session can otherwise restore tools from its persisted configuration.

The CLI adapter starts and resumes runs, translates the stream events Passoff uses, and reports completion, failure, denied tool calls, and questions. In print mode, Claude denies commands that need approval and includes them in the final `permission_denials` array. A stdio consumer does not receive an interactive approval callback, even with `--permission-prompts host`. A live approval loop would require the official Agent SDK or another supported permission host. Do not depend on Claude Code's private transcript layout.

## Permissions

The first target is a read-only reviewer. It can inspect files and Git state. It cannot edit files, commit, change configuration, or approve its own permission requests.

The first reviewer flow does not run project tests. Test suites often write caches, coverage data, snapshots, or generated files. Add test execution after we have measured those writes and can grant only the access each check needs.

When Codex needs more access, Passoff records `approval.required`, interrupts the noninteractive turn, and returns a blocked result. A Claude print-mode reviewer also runs fail-closed: permission-requiring calls are denied and the final result is reported as blocked. A future live approval round trip would require an interactive permission host. Blanket permission bypass flags are out.

An implementer role comes later and runs in an isolated Git worktree.

## Run records

Store sessions and runs in the user's application-state directory, outside the target repository. Use the platform convention: `~/Library/Application Support/passoff` on macOS, `$XDG_STATE_HOME/passoff` or `~/.local/state/passoff` on Linux, and `%LOCALAPPDATA%\\passoff` on Windows.

Key each project by a stable hash of its canonical repository path:

```text
<state-dir>/
└── projects/
    └── <repository-key>/
        ├── sessions/
        │   └── <session-key>.json
        ├── run-index/
        │   └── <session-key>.json
        └── runs/
            └── <run-id>/
                ├── handoff.json
                ├── events.ndjson
                ├── result.json
                └── provider.json (only with --debug-capture)
```

Each session key is a stable hash of the harness ID and user-supplied session name. Keeping one session per file lets concurrent updates to different names use atomic replacement without a shared read-modify-write lock.

The run index points each named session to its latest run. Passoff writes the result first and marks the handoff terminal last, so `inspect` cannot mistake a partial write for a completed run.

Callers may identify themselves with `--source claude` or `--source codex`. Omitted sources are recorded as unknown.

Provider messages are not stored unless `--debug-capture` is set. Debug capture removes known credential and environment fields, limits each message, and stops retaining messages when the capture reaches its count or byte limit.

Passoff handles `SIGINT`, `SIGTERM`, and explicit deadlines while the CLI is running. It asks the native harness to interrupt its active turn, then writes an interrupted result before exiting. An uncatchable process stop such as `SIGKILL` can still leave the latest run marked `running`.

The POC assumes one active run per named session. [Issue #6](https://github.com/Undiluted7027/passoff/issues/6) tracks how Passoff prevents simultaneous use of the same session.

Write files atomically when an interrupted write could corrupt the run. Records may contain native session IDs, task text, and model output. Do not intentionally record provider credentials or environment-variable values. Redact known sensitive fields before persisting provider payloads, and treat the remaining run record as sensitive because user-supplied tasks and model output can contain secrets.

## Review result

A reviewer returns a compact result that the parent agent can act on:

```ts
type ReviewResult = {
  status: "approved" | "changes_requested" | "blocked";
  summary: string;
  findings: Array<{
    severity: "low" | "medium" | "high";
    file?: string;
    line?: number;
    problem: string;
    evidence?: string;
    suggestedFix?: string;
  }>;
  checks: Array<{
    command: string;
    outcome: "passed" | "failed" | "not_run";
  }>;
};
```

Use native structured output when the harness supports it. Otherwise validate the response and reject invalid output. Do not invent missing values.

## Failures we need to handle

- The harness executable is missing.
- The harness is not authenticated.
- A native session cannot resume.
- The target asks for permission or user input.
- The target exits without a final result.
- The structured result is invalid.
- The process is interrupted or reaches its deadline.
- Repository state changes during review.

Keep the native session ID and normalized event log after a failure whenever possible. A failed run should still be inspectable and resumable.

Native terminal events decide whether a run completed, failed, or was interrupted; a process exit code cannot override them. A host action request from a noninteractive reviewer produces a blocked result and is never approved by Passoff. Passoff fingerprints HEAD, tracked changes, non-ignored untracked files, and initialized submodule revisions before and after the review. Initialized submodules must be clean because Passoff cannot safely validate a verdict against changing nested worktrees.

## Tests

Test the adapter boundary and the cases most likely to break the product:

- Translate representative native events into Passoff events.
- Capture and save native session IDs.
- Resume the same target session.
- Keep progress on stderr and the result on stdout.
- Surface approval requests instead of accepting them.
- Leave useful run records after a failure.

Use recorded protocol fixtures for normal tests. Keep one explicit, opt-in end-to-end check for each installed harness. Running the ordinary test suite should never spend model credits.

## Build order

1. Drive the event and result types with adapter tests.
2. Connect to `codex app-server`.
3. Connect to Claude Code's structured CLI output.
4. Implement new and resumed sessions in `passoff ask`.
5. Save handoffs, events, and results.
6. Teach both harnesses to invoke Passoff.
7. Run the complete review and verification demo.
8. Add a terminal view only if the event stream is hard to follow.

## Done means

- Claude Code can start a Codex review through Passoff.
- Codex can start a Claude Code review through Passoff.
- Either harness can resume the same target session for a follow-up.
- The target reads the repository instead of receiving the source transcript.
- The caller can see progress, permission requests, failures, and completion.
- Results pass runtime validation.
- Passoff never handles provider credentials.
- The demo runs without manual copying between harnesses.
