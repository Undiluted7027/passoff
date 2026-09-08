# Passoff - task delegation on steroids

The idea is to make LLM harnesses + agents talk to each other. Think: Claude code passing off to Codex/OpenCode/Pi/Conductor or vice versa. All things communicating with each other.

## Important

Your code must be such that it is readable, reviewable and can be maintained by other devs in the future. If the product itself is working but I can't explain how or even I can't understand what you did, that implementation and work will be moot. Always focus on implementability, maintainability, and simplicity.

I would rather see six tests that specifically cover the difficult cases and business logic than forty tests that only repeat happy-path checks and are coverage maxxers.


## Coding preferences - general

- Keep things simple. Channel "yagni" energy unless told otherwise.
- Typesafety is useful, take advantage of it.
- Be pragmatic about eslint ignores. Whenever using eslint ignore declaratives,
  explicitly add comment stating the justification. Not all eslint rules will
  accurately describe the problem/convention. This is especially true for security
  related rules that may require deeper invetigation and analysis before deciding to
  use eslint ignores.
- Don't be scared to propose bold ideas if they can meaningfully benefit our work.
- Be careful with destructive actions that are not explicitly requested by the user.
- Tests are good! Endless smoke tests, "regression tests" for feature deletions, etc,
  much less good. Tests should be focused, not slop.
- Comments are a great way to clarify functionality and how code is used. Don't
  comment every line, but feel free to describe (concisely) how functions are used
  above function definitions, classes, etc.
- Keep comments up to date! When making changes, it's important to keep things in
  sync.


## Coding preferences (Typescript focused)

- Never edit ANY config files like 'tsconfig.json', 'eslint.config.js', 'drizzle.config.ts' etc. without asking for explicit permissions.
- `any` is the enemy. Inferred types are our friend. Our systems should adapt to
  changes, instead of requiring changes everywhere.
- If your TS code looks like a Python dev wrote it, it is bad TS code.
- Avoid one-line functions that are just casting wrappers.
- Write TypeScript in ways that Matt Pocock and Theo Browne would be proud of.


## Build Preferences

- Always build in terms of features. Never rely solely on backend, frontend, db, etc.
- Build in increments or slices.
- Test driven development is nice.

## Additional
- We don't shy away from Python but we try to avoid it because it's typing system is not that great.


## POC implementation guidance

The project description and coding preferences above are canonical. Do not reinterpret, replace, or weaken them based on this section or on the POC specification. When guidance conflicts, follow the instructions above and ask Sanchit only when the conflict cannot be resolved safely.

The current proof-of-concept specification is in [`docs/poc.md`](docs/poc.md). Read it before planning or implementing POC work.

For the POC:

- Build a local, credentials-blind orchestration layer for installed native harnesses.
- Support Claude Code and Codex first. Do not add another harness until both directions of the initial handoff work.
- Integrate through supported native interfaces: Codex app-server and Claude Code's structured CLI or official Agent SDK.
- Preserve native sessions and store their identifiers as opaque values.
- Transfer bounded tasks and repository references. Do not translate or copy complete conversation histories between harnesses.
- Start with a read-only reviewer flow. Do not allow concurrent edits or blanket permission bypasses.
- Keep provider-specific behavior inside typed adapters. Normalize only the lifecycle events the product currently needs.
- Prefer recorded protocol fixtures for tests. Model-consuming end-to-end tests must be explicit and opt-in.
- Keep the first user-facing surface to a small CLI. Add a daemon, database, terminal UI, MCP server, or hosted service only when a working feature requires it.
- Vercel AI SDK may be used later for UI streaming or a Passoff-owned coordinator. It must not replace the native harness integrations at the core of the POC.
