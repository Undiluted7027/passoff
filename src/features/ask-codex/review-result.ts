import { z } from "zod";

const reviewFindingFields = {
  severity: z.enum(["low", "medium", "high"]),
  problem: z.string().min(1),
};

const optionalReviewFindingFields = {
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  evidence: z.string().min(1).optional(),
  suggestedFix: z.string().min(1).optional(),
};

const reviewFindingSchema = z.strictObject({
  ...reviewFindingFields,
  ...optionalReviewFindingFields,
});

const reviewCheckSchema = z.strictObject({
  command: z.string().min(1),
  outcome: z.enum(["passed", "failed", "not_run"]),
});

const reviewResultFields = {
  status: z.enum(["approved", "changes_requested", "blocked"]),
  summary: z.string().min(1),
  checks: z.array(reviewCheckSchema),
};

export const reviewResultSchema = z.strictObject({
  ...reviewResultFields,
  findings: z.array(reviewFindingSchema),
});

export type ReviewResult = z.infer<typeof reviewResultSchema>;

// Codex structured output requires every property to be present. Fields that
// are optional in Passoff's result therefore travel over the wire as nullable.
export const codexReviewResultSchema = z.strictObject({
  ...reviewResultFields,
  findings: z.array(
    z.strictObject({
      ...reviewFindingFields,
      file: z.string().min(1).nullable(),
      line: z.number().int().positive().nullable(),
      evidence: z.string().min(1).nullable(),
      suggestedFix: z.string().min(1).nullable(),
    }),
  ),
});

type CodexReviewFinding = z.infer<
  typeof codexReviewResultSchema
>["findings"][number];

export function parseReviewResult(
  text: string,
  provider = "Codex",
): ReviewResult {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${provider} returned a final answer that is not valid JSON.`);
  }

  return parseReviewResultValue(value, provider);
}

export function parseReviewResultValue(
  value: unknown,
  provider: string,
): ReviewResult {
  const result = codexReviewResultSchema.safeParse(value);

  if (!result.success) {
    throw new Error(
      `${provider} returned an invalid review result: ${z.prettifyError(result.error)}`,
    );
  }

  return {
    ...result.data,
    findings: result.data.findings.map(normalizeFinding),
  };
}

function normalizeFinding(finding: CodexReviewFinding): ReviewResult["findings"][number] {
  return {
    severity: finding.severity,
    problem: finding.problem,
    ...(finding.file === null ? {} : { file: finding.file }),
    ...(finding.line === null ? {} : { line: finding.line }),
    ...(finding.evidence === null ? {} : { evidence: finding.evidence }),
    ...(finding.suggestedFix === null
      ? {}
      : { suggestedFix: finding.suggestedFix }),
  };
}
