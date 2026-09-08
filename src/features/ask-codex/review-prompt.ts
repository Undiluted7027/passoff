import { z } from "zod";

import { codexReviewResultSchema } from "./review-result.ts";

type ReviewPromptInput = {
  task: string;
  repository: string;
  baseRevision: string;
};

export const reviewOutputSchema = z.toJSONSchema(codexReviewResultSchema);

export function buildReviewPrompt(input: ReviewPromptInput): string {
  return `You are reviewing a change in ${input.repository}.

Task from the caller:
${input.task}

Compare the working tree with base commit ${input.baseRevision}. Inspect the relevant files and Git diff. Report concrete correctness, security, and maintainability problems that the author can act on.

This is a read-only review. Do not edit files, change configuration, commit, or run project tests. Return only the requested structured review result. Use an empty findings array when the change is sound. Record checks you did not run with outcome "not_run".`;
}
