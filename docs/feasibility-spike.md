# Passoff feasibility spike

Date: 2026-09-07; rechecked after Codex upgrade  
Environment: macOS, Codex CLI 0.153.4, Claude Code 2.1.263

## Decision

**Go** for the first Claude-to-Codex read-only review slice, with two conditions:

1. Verify that the configured or default model appears in app-server `model/list` before starting a turn. This spike passed on Codex CLI 0.153.4; capability checks remain authoritative because a version number alone does not guarantee model compatibility.
2. The Claude caller must invoke Passoff with an explicit allow rule while remaining in restricted mode; Passoff then owns the Codex app-server process and its read-only policy.

The full bidirectional POC is not proven yet. Restricted Claude can launch read-only Codex, but read-only Codex cannot launch Claude with Claude's existing native login. A host-side app-server dynamic tool works around that limit. It currently depends on Codex's experimental API and needs adapter tests before product code relies on it.

## Results

| Question | Result | Evidence |
| --- | --- | --- |
| Can Codex invoke Claude without weakening its sandbox? | **Yes through a host callback; no as a shell child.** | A Claude shell child started by read-only Codex returned exit 1 with `terminal_reason: "api_error"` and `Not logged in`. A narrow app-server dynamic tool let the host start restricted Claude successfully while Codex remained `readOnly` with network disabled and approval policy `never`. |
| Can Claude invoke Codex under equivalent restrictions? | **Mechanically yes; enforcement remains Passoff's job.** | Claude ran in `--restricted --strict-mcp-config` with only `Bash`; an explicit `Bash(codex exec *)` allow rule launched Codex with `--sandbox read-only`. Codex emitted a thread ID and returned the expected marker. The probe instructed Claude to supply the safe Codex flags, so the product still needs to enforce them itself. |
| Did Codex session lifecycle operations work in this spike? | **Yes.** | On 0.153.4, the app-server advertised `gpt-6-astra` as its default and completed a default-model turn. `thread/start` returned a UUIDv7 thread/session ID, `thread/resume` in a fresh process returned the same ID, and `turn/interrupt` returned `{}` before the terminal status became `interrupted`. |
| Did Claude session lifecycle operations work in this spike? | **Yes, with a limitation.** | The init event exposed `session_id`; `--resume` reused it after SIGINT. SIGINT produced a result with `subtype: "error_during_execution"` and `terminal_reason: "aborted_streaming"`; the CLI then exited 0. The requested `sleep` command was blocked before interruption, so this did not prove cancellation of an active tool. |
| Are approvals equivalent? | **No.** | Codex emits a JSON-RPC server request that the host can answer. Plain Claude print mode auto-denies permission-requiring calls and reports them later in `permission_denials`; no interactive control request was emitted to a plain stdio client. |
| Is malformed structured output a native failure? | **No, unless native schema enforcement is requested and succeeds.** | Without a schema, both harnesses returned `NOT_JSON` as a successful completed run. Passoff must validate the final payload and synthesize `session.failed` for invalid results. |

## Observed event shapes

Sanitized Codex lifecycle:

```json
{"event":"thread.started","threadId":"<opaque>","sandbox":{"type":"readOnly","networkAccess":false}}
{"event":"turn.started","turnId":"<opaque>","status":"inProgress"}
{"event":"agentMessage.completed","phase":"final_answer","text":"RESUME_OK"}
{"event":"turn.completed","status":"completed","error":null}
```

Sanitized Codex approval:

```json
{"method":"item/commandExecution/requestApproval","id":0,"params":{"threadId":"<opaque>","turnId":"<opaque>","itemId":"<opaque>","kind":"command","command":"/bin/zsh -lc 'uname -a'","availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["uname","-a"]}},"cancel"]}}
```

Declining the request did not fail the native turn. Codex produced a final answer saying the command was rejected, then emitted `turn/completed` with status `completed`. Passoff must derive reviewer status from the validated result, not from turn status alone.

Sanitized Claude completion and interruption:

```json
{"type":"system","subtype":"init","session_id":"<opaque>","permissionMode":"dontAsk"}
{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","session_id":"<opaque>","result":"RESUME_OK","permission_denials":[]}
{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","session_id":"<opaque>","errors":["<diagnostic>"]}
```

Sanitized Claude permission denial:

```json
{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":"Permission denied.","permission_denials":[{"tool_name":"Bash","tool_use_id":"<opaque>","tool_input":{"command":"curl -I https://example.com"}}]}
```

Process exit codes are not enough. Codex app-server exited 0 after a failed turn, and Claude exited 0 after an interrupted stream. Each adapter must inspect the native terminal status.

## Adapter boundaries

The shared layer owns delegation input, lifecycle events, validated review results, deadlines, and opaque session IDs.

The Codex adapter owns JSON-RPC framing, initialization capabilities, generated protocol types, model discovery, thread and turn IDs, final-answer selection, server-request correlation, and turn interruption. It registers one narrow handoff dynamic tool so a sandboxed Codex process does not have to launch another authenticated harness.

The Claude adapter owns process arguments, restricted tool configuration, strict MCP isolation, stream parsing, session resumption, signals, final `result` interpretation, and `permission_denials`. Every resumed invocation receives the restrictions again.

Result validation is provider-independent. A native completion with invalid JSON or a schema mismatch becomes Passoff `session.failed`. Missing fields remain missing.

## Upgrade result

The Codex upgrade resolved the original model mismatch. CLI 0.152.1 inherited `gpt-6-astra` but rejected it as requiring a newer version. CLI 0.153.4 advertises `gpt-6-astra` in `model/list`, marks it as the default, and completed start, resume, and interrupt checks with that model.

## Evidence limits

- Each lifecycle path was exercised once. The spike establishes feasibility, not production reliability.
- The event samples above are sanitized excerpts in this memo. Persist representative fixtures before writing adapter tests.
- The Claude-to-Codex probe allowed `Bash(codex exec *)` and instructed Claude to pass `--sandbox read-only`. The product must enforce Codex's sandbox and approval policy itself rather than trusting the calling agent to supply safe flags.

## Remaining blockers and next proof

- Keep an early version/catalog compatibility check so an unsupported configured model fails before a review turn starts.
- Codex dynamic tools require `initialize.capabilities.experimentalApi: true`. The Codex-to-Claude path depends on this experimental API.
- Claude CLI print mode is fail-closed but cannot provide a live approval round trip to a plain stdio adapter. Decide whether denied-and-blocked is sufficient for the reviewer POC; otherwise spike the official Agent SDK before implementing approvals.
- Claude restrictions must include `--strict-mcp-config`. A resume test without it exposed persisted MCP tools despite an explicit `--tools Read` list.
- Structured Codex runs can emit commentary-shaped agent messages before the final answer. Select `phase: "final_answer"`; never concatenate every message delta into the result.

Build the Claude -> Passoff CLI -> Codex app-server -> validated review result -> Claude path next. Record the app-server events as fixtures, then add one opt-in end-to-end check using the installed harnesses.
