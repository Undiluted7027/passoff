import { z } from "zod";

import { reviewResultSchema } from "../ask-codex/review-result.ts";

export const harnessIdSchema = z.enum(["claude", "codex"]);
export const reviewStatusSchema = z.enum([
  "approved",
  "changes_requested",
  "blocked",
]);
export const runStatusSchema = z.enum([
  "running",
  ...reviewStatusSchema.options,
  "failed",
  "interrupted",
]);

export const handoffFileSchema = z.strictObject({
  version: z.literal(1),
  runId: z.uuid(),
  task: z.string().min(1),
  repository: z.string().min(1),
  baseRevision: z.string().min(1),
  sourceHarness: harnessIdSchema.nullable(),
  targetHarness: harnessIdSchema,
  sessionName: z.string().min(1).nullable(),
  nativeSessionId: z.string().min(1).nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  status: runStatusSchema,
  failureReason: z.string().min(1).nullable(),
});

const completedResultSchema = z.strictObject({
  version: z.literal(1),
  runId: z.uuid(),
  status: reviewStatusSchema,
  finishedAt: z.iso.datetime(),
  review: reviewResultSchema,
});

const failedResultSchema = z.strictObject({
  version: z.literal(1),
  runId: z.uuid(),
  status: z.enum(["failed", "interrupted"]),
  finishedAt: z.iso.datetime(),
  failureReason: z.string().min(1),
});

export const runResultFileSchema = z.union([
  completedResultSchema,
  failedResultSchema,
]);

export const runEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("handoff.started"),
    timestamp: z.iso.datetime(),
  }),
  z.strictObject({
    type: z.literal("session.started"),
    timestamp: z.iso.datetime(),
    sessionId: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("approval.required"),
    timestamp: z.iso.datetime(),
    method: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("session.completed"),
    timestamp: z.iso.datetime(),
    status: reviewStatusSchema,
  }),
  z.strictObject({
    type: z.literal("session.failed"),
    timestamp: z.iso.datetime(),
    message: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("session.interrupted"),
    timestamp: z.iso.datetime(),
    message: z.string().min(1),
  }),
]);

export type HarnessId = z.infer<typeof harnessIdSchema>;
export type HandoffFile = z.infer<typeof handoffFileSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunResultFile = z.infer<typeof runResultFileSchema>;

export type StoredRun = {
  handoff: HandoffFile;
  events: RunEvent[];
  result?: RunResultFile;
  providerExcerpts?: JsonValue[];
};

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
