import { z } from "zod";

// These schemas cover only the app-server fields this slice reads. Codex may
// add fields without breaking Passoff, while changes to required fields fail.
export const requestIdSchema = z.union([z.number(), z.string()]);

export const rpcResponseSchema = z
  .object({
    id: requestIdSchema,
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const rpcMessageSchema = z
  .object({
    method: z.string(),
    id: requestIdSchema.optional(),
    params: z.unknown().optional(),
  })
  .passthrough();

export const modelListResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      model: z.string(),
      isDefault: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const threadStartResponseSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
  model: z.string(),
});

export const turnStartResponseSchema = z.object({
  turn: z.object({ id: z.string().min(1) }),
});

const itemCompletedSchema = z.object({
  method: z.literal("item/completed"),
  params: z.object({
    item: z
      .object({
        type: z.string(),
      })
      .passthrough(),
  }),
});

const turnCompletedSchema = z.object({
  method: z.literal("turn/completed"),
  params: z.object({
    turn: z.object({
      status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
      error: z
        .object({ message: z.string() })
        .passthrough()
        .nullable()
        .optional(),
    }),
  }),
});

const errorNotificationSchema = z.object({
  method: z.literal("error"),
  params: z.object({
    error: z.object({ message: z.string() }).passthrough(),
    willRetry: z.boolean(),
  }),
});

export const codexLifecycleMessageSchema = z.union([
  itemCompletedSchema,
  turnCompletedSchema,
  errorNotificationSchema,
]);

export type RpcMessage = z.infer<typeof rpcMessageSchema>;
