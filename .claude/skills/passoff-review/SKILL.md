---
name: passoff-review
description: Ask Codex to review the current implementation through Passoff, fix actionable findings, and resume the same Codex session to verify the fixes. Use when the user asks for a Codex review or a cross-harness review.
argument-hint: "[review focus]"
---

# Passoff review

Use Passoff to send Codex a bounded, read-only review task. Passoff returns a
structured result; do not copy conversation history into the task.

1. Choose a short, descriptive session name and keep it unchanged throughout
   this review cycle.
2. Treat the following text as the requested review focus: `$ARGUMENTS`. When it
   is empty, describe the implementation being reviewed.
3. Run the following command from the repository root. Replace the placeholders
   with shell-quoted values.

   ```bash
   bun run passoff ask codex \
     --source claude \
     --role reviewer \
     --session <session-name> \
     --base HEAD \
     "<bounded-review-task>"
   ```

4. Read the JSON result from stdout:
   - `approved`: report the verdict and stop.
   - `changes_requested`: assess each finding, make the warranted fixes, and
     run the relevant local checks.
   - `blocked`: report what Codex needs and stop. Do not weaken permissions.
5. After fixing findings, run the command again with the same session name and
   base revision. Ask Codex to verify the fixes against its earlier findings.
6. Do not use `--debug-capture` unless the user asks for provider diagnostics.

Passoff progress appears on stderr. A failed command or invalid result is a
handoff failure; surface it instead of treating the review as approved.
