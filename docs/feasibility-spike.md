# Passoff feasibility spike

Date: 2026-09-07; rechecked after Codex upgrade  
Environment: macOS, Codex CLI 0.153.4, Claude Code 2.1.263

## Decision

**Go** for the first Claude-to-Codex read-only review slice, with two conditions:

1. Require Codex CLI 0.153.4 or newer for this environment and verify the configured/default model appears in app-server `model/list` before starting a turn.
2. The Claude caller must invoke Passoff with an explicit allow rule while remaining in restricted mode; Passoff then owns the Codex app-server process and its read-only policy.

Do not claim the full bidirectional POC is complete yet. Direct shell execution is asymmetric: restricted Claude can launch read-only Codex, but read-only Codex cannot launch Claude with Claude's existing native login. The tested host-side app-server dynamic-tool boundary fixes that asymmetry, but it currently requires Codex's experimental API capability and needs adapter tests before product work relies on it.

## Results

| Question | Result | Evidence |
| --- | --- | --- |
| Can Codex invoke Claude without weakening its sandbox? | **Yes through a host callback; no as a shell child.** | A Claude shell child started by read-only Codex returned exit 1 with `terminal_reason: "api_error"` and `Not logged in`. A narrow app-server dynamic tool let the host start restricted Claude successfully while Codex remained `readOnly` with network disabled and approval policy `never`. |
| Can Claude invoke Codex under equivalent restrictions? | **Yes.** | Claude ran in `--restricted --strict-mcp-config` with only `Bash`; an explicit `Bash(codex exec *)` allow rule launched Codex with `--sandbox read-only`. Codex emitted a thread ID and returned the expected marker. |
| Can Codex sessions start, identify, resume, and interrupt? | **Yes.** | On 0.153.4, the app-server advertised `gpt-6-astra` as its default and completed a default-model turn. `thread/start` returned a UUIDv7 thread/session ID, `thread/resume` in a fresh process returned the same ID, and `turn/interrupt` returned `{}` before the terminal status became `interrupted`. |
| Can Claude sessions start, identify, resume, and interrupt? | **Yes, with process-level interruption in CLI mode.** | The init event exposed `session_id`; `--resume` reused it, including after SIGINT. SIGINT produced a result with `subtype: "error_during_execution"` and `terminal_reason: "aborted_streaming"`; the CLI then exited 0. |
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

Important: process exit codes are not sufficient for either adapter. Codex app-server exited 0 after a failed turn, and Claude exited 0 after an interrupted stream. Native terminal status is authoritative.

## Adapter boundaries

Keep the shared layer limited to delegation input, lifecycle events, validated review results, deadlines, and opaque session IDs.

The Codex adapter should own JSON-RPC framing, initialization capabilities, generated protocol types, model discovery, thread/turn IDs, final-answer phase selection, server-request correlation, and turn interruption. The host-facing Codex integration should register one narrow handoff dynamic tool rather than letting a sandboxed Codex shell launch another authenticated harness.

The Claude adapter should own process arguments, restricted tool configuration, strict MCP isolation, stream parsing, session resumption, signals, final `result` interpretation, and `permission_denials`. Treat a resumed invocation as a fresh security configuration boundary and pass restrictions every time.

The result validator should be provider-independent. A native successful completion with invalid JSON or a schema mismatch becomes Passoff `session.failed`; do not invent missing fields.

## Upgrade result

The Codex upgrade resolved the original model mismatch. CLI 0.152.1 inherited `gpt-6-astra` but rejected it as requiring a newer version. CLI 0.153.4 advertises `gpt-6-astra` in `model/list`, marks it as the default, and completed start, resume, and interrupt checks with that model.

## Remaining blockers and next proof

- Keep an early version/catalog compatibility check so an unsupported configured model fails before a review turn starts.
- Codex dynamic tools require `initialize.capabilities.experimentalApi: true`; this is the main risk for the later Codex-to-Claude direction.
- Claude CLI print mode is fail-closed but cannot provide a live approval round trip to a plain stdio adapter. Decide whether denied-and-blocked is sufficient for the reviewer POC; otherwise spike the official Agent SDK before implementing approvals.
- Claude restrictions must include `--strict-mcp-config`. A resume test without it exposed persisted MCP tools despite an explicit `--tools Read` list.
- Structured Codex runs can emit commentary-shaped agent messages before the final answer. Select `phase: "final_answer"`; never concatenate every message delta into the result.

The next implementation slice should cover only Claude -> Passoff CLI -> Codex app-server -> validated review result -> Claude. Record the generated app-server event shapes as fixtures, then add one opt-in end-to-end check using the installed harnesses.
