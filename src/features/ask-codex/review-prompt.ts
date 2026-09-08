import { z } from "zod";

import { codexReviewResultSchema } from "./review-result.ts";

type ReviewPromptInput = {
  task: string;
  repository: string;
  baseRevision: string;
  /** Host-generated context for a reviewer that cannot run Git itself. */
  changeContext?: string;
};

export const reviewOutputSchema = z.toJSONSchema(codexReviewResultSchema);

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const inspection = input.changeContext
    ? `Passoff computed the bounded Git context below on the host. Use it as the change boundary and read listed files that still exist when more detail is needed. Do not run Git commands.\n\n${input.changeContext}`
    : `Compare the working tree with base commit ${input.baseRevision}. Inspect the relevant files and Git diff.`;

  return `You are reviewing a change in ${input.repository}.

Task from the caller:
${input.task}

${inspection}

Report concrete correctness, security, and maintainability problems that the author can act on.

This is a read-only review. Do not edit files, change configuration, commit, or run project tests. Return only the requested structured review result. Use an empty findings array when the change is sound. Record checks you did not run with outcome "not_run".`;
}
