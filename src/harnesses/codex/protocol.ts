import { z } from "zod";

// These schemas cover only the app-server fields this slice reads. Codex may
// add fields without breaking Passoff, while changes to required fields fail.
export const requestIdSchema = z.union([z.number(), z.string()]);

export const rpcResponseSchema = z.looseObject({
  id: requestIdSchema,
  result: z.unknown().optional(),
  error: z
    .looseObject({
      code: z.number(),
      message: z.string(),
    })
    .optional(),
});

export const rpcMessageSchema = z.looseObject({
  method: z.string(),
  id: requestIdSchema.optional(),
  params: z.unknown().optional(),
});

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

export const threadOpenResponseSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
  model: z.string(),
});

export const turnStartResponseSchema = z.object({
  turn: z.object({ id: z.string().min(1) }),
});

export const turnInterruptResponseSchema = z.looseObject({});

export const dynamicToolCallSchema = z.object({
  method: z.literal("item/tool/call"),
  id: requestIdSchema,
  params: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    callId: z.string().min(1),
    namespace: z.string().nullable(),
    tool: z.string().min(1),
    arguments: z.unknown(),
  }),
});

const itemCompletedSchema = z.object({
  method: z.literal("item/completed"),
  params: z.object({
    item: z.looseObject({
      type: z.string(),
    }),
  }),
});

const turnCompletedSchema = z.object({
  method: z.literal("turn/completed"),
  params: z.object({
    turn: z.object({
      status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
      error: z
        .looseObject({ message: z.string() })
        .nullable()
        .optional(),
    }),
  }),
});

const errorNotificationSchema = z.object({
  method: z.literal("error"),
  params: z.object({
    error: z.looseObject({ message: z.string() }),
    willRetry: z.boolean(),
  }),
});

export const codexLifecycleMessageSchema = z.union([
  itemCompletedSchema,
  turnCompletedSchema,
  errorNotificationSchema,
]);

export type RpcMessage = z.infer<typeof rpcMessageSchema>;
