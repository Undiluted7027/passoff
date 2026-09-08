# Claude Code to Codex reviews

Claude Code can use Passoff as a project skill to request a read-only Codex
review. The skill lives at `.claude/skills/passoff-review/SKILL.md` and is
available as `/passoff-review` inside this repository. Claude may also select it
when asked to get a Codex or cross-harness review.

## Review loop

Ask Claude to implement a change and have Codex review it, or invoke the skill
directly:

```text
/passoff-review check the current implementation for lifecycle bugs
```

Claude runs the equivalent of:

```bash
bun run passoff ask codex \
  --source claude \
  --role reviewer \
  --session lifecycle-review \
  --base HEAD \
  "Review the current implementation for lifecycle bugs"
```

The command writes progress to stderr and one structured review result to
stdout. Claude handles that result as follows:

- `approved`: report the verdict.
- `changes_requested`: assess the findings, fix the ones that apply, then ask
  Codex to verify the fixes.
- `blocked`: report the missing permission or information without weakening the
  review restrictions.

The verification call must use the same `--session` value and `--base` revision:

```bash
bun run passoff ask codex \
  --source claude \
  --role reviewer \
  --session lifecycle-review \
  --base HEAD \
  "Verify the fixes against your earlier findings"
```

Passoff maps the friendly session name to Codex's opaque native thread ID. The
task contains the review objective and repository reference, not Claude's
conversation history.

## Live POC check

The model-consuming check is intentionally manual. Start Claude Code in this
repository and give it a small implementation task:

```bash
claude
```

```text
Make a small, reviewable change requested by the user. Use /passoff-review to
have Codex review it. Address applicable findings, then resume the same Codex
session and ask it to verify the fixes.
```

The check passes when Claude completes the review and fix cycle without the user
copying prompts or results between harnesses, and the resumed Codex session
returns an approved result.
