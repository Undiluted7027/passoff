# Passoff proof of concept

## What we are building

Passoff lets one coding agent give a bounded task to another and get an answer back. Both agents stay inside their native harnesses, with their own sessions, tools, prompts, permissions, and context management.

The POC connects Claude Code and Codex on the user's machine. It drives their installed CLIs using the authentication they already have. Passoff does not call model APIs, copy entire chat histories, or try to become another coding harness.

The bet is simple: pass the work, not the context window.

## The demo

The first demo has Claude Code implement a feature and ask Codex to review it.

1. The user asks Claude Code to implement a small feature and have Codex review it.
2. Claude Code runs `passoff ask codex --role reviewer`.
3. Passoff starts a Codex thread in the same repository and gives it a focused review task.
4. Codex reads the code and current diff, then reports its findings.
5. Claude Code fixes the problems.
6. Claude Code calls Passoff again with the same named Codex session.
7. Codex resumes its thread, checks the fixes, and runs the relevant tests.
8. Codex returns its verdict.

No one copies messages between terminals. Both native sessions still work afterward. If we cannot make that loop reliable, the rest of the product does not matter yet.

## Boundaries

A handoff tells the target what job to do and where to work. The target reads the repository and builds its own understanding. Dumping one model's transcript into another is the problem we are trying to avoid.

The POC runs locally and stays away from credentials:

- Users install and authenticate their own harnesses.
- Each harness chooses its configured authentication method.
- Passoff never reads, stores, proxies, or implements provider credentials.
- Native session IDs are opaque strings to Passoff.
- Hosted execution and account management can wait.

## Scope

The POC has Claude Code and Codex adapters, one `passoff ask` command, resumable target sessions, a read-only reviewer role, structured events and results, local run records, and instructions that teach both harnesses how to invoke Passoff.

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
  --role reviewer \
  --session auth-review \
  "Review the current diff for authorization bugs"
```

Use the same session name for a follow-up:

```bash
passoff ask codex \
  --session auth-review \
  "Verify the fixes and run the relevant tests"
```

Progress goes to stderr. The final machine-readable result goes to stdout, which keeps the command useful to people, scripts, and parent agents.

Commands such as `passoff list`, `passoff inspect`, and `passoff interrupt` should exist only when the working demo needs them.

## Handoff format

The shared type describes the job and its source and target. Provider details belong in the adapters.

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

The target prompt gets the objective, role, working directory, current Git revision when available, and expected result format. It also tells the target to inspect the repository itself. It does not contain the source agent's full conversation.

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

interface HarnessAdapter {
  readonly id: HarnessId;
  readonly capabilities: HarnessCapabilities;

  start(input: StartInput): AsyncIterable<HarnessEvent>;
  resume(input: ResumeInput): AsyncIterable<HarnessEvent>;
  interrupt(sessionId: string): Promise<void>;
}
```

The first adapter tests should drive the exact input types. Do not add fields because they might be useful later.

## Events

Passoff needs a small common event vocabulary:

```ts
type HarnessEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "message.delta"; text: string }
  | { type: "tool.started"; name: string }
  | { type: "tool.completed"; name: string }
  | { type: "approval.required"; request: ApprovalRequest }
  | { type: "session.completed"; result: string }
  | { type: "session.failed"; message: string };
```

That is enough for the POC. Record raw provider events for debugging, but do not turn every event either provider emits into public Passoff API.

## Codex integration

Run the installed `codex app-server` and use its documented JSON-RPC transport. Generate TypeScript definitions from the installed CLI when practical instead of maintaining guessed protocol types.

The adapter initializes the server, starts or resumes a thread, starts a turn, translates the events Passoff cares about, and interrupts a turn when asked. Approval requests must reach the caller. The adapter must never approve them itself.

## Claude Code integration

Start with the installed Claude Code CLI in print mode with structured streaming. Capture its session ID and pass that ID to `--resume` for follow-ups.

The official TypeScript Agent SDK is an option if it makes lifecycle handling materially simpler. We should not switch merely because an SDK looks cleaner in a dependency list.

The adapter starts and resumes runs, translates useful stream events, and reports completion, failure, permission requests, and questions. It must use supported CLI or SDK operations instead of depending on Claude Code's private transcript layout.

## Permissions

The first target is a read-only reviewer. It can inspect files and Git state, and run checks we explicitly allow. It cannot edit files, commit, change configuration, or approve its own permission requests.

When the target needs more access, Passoff emits `approval.required` and gives the decision back to the invoking harness or user. Blanket permission bypass flags are out.

An implementer role comes later and runs in an isolated Git worktree.

## Run records

Plain files are enough to start:

```text
.passoff/
└── runs/
    └── <run-id>/
        ├── handoff.json
        ├── events.ndjson
        └── result.json
```

Write files atomically when an interrupted write could corrupt the run. Records may contain native session IDs and raw events. They must never contain credentials or environment-variable values.

Before writing `.passoff/` inside another repository, make sure Git will ignore it. Editing an existing `.gitignore` requires permission under this repository's instructions.

## Review result

A reviewer returns something the parent agent can use without reading an essay:

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

Use native structured output when the harness supports it. Otherwise validate the response and report bad output as bad output. Do not fill gaps with invented values.

## Failures we need to handle

- The harness executable is missing.
- The harness is not authenticated.
- A native session cannot resume.
- The target asks for permission or user input.
- The target exits without a final result.
- The structured result is invalid.
- The process is interrupted or reaches its deadline.
- Repository state changes during review.

Keep the native session ID and raw event log after a failure whenever possible. A failed run should still be inspectable and resumable.

## Tests

Tests should concentrate on the adapter boundary and the cases likely to break the product:

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
