import { z } from "zod";

const permissionDenialSchema = z.looseObject({
  tool_name: z.string().min(1),
});

export const claudeStreamMessageSchema = z.union([
  z.looseObject({
    type: z.literal("system"),
    subtype: z.literal("init"),
    session_id: z.string().min(1),
  }),
  z.looseObject({
    type: z.literal("result"),
    subtype: z.string(),
    is_error: z.boolean(),
    terminal_reason: z.string().optional(),
    session_id: z.string().min(1),
    result: z.string().optional(),
    structured_output: z.unknown().optional(),
    permission_denials: z.array(permissionDenialSchema).default([]),
    errors: z.array(z.string()).optional(),
  }),
]);
