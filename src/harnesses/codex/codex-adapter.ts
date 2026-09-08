import { z } from "zod";

import {
  parseReviewResult,
  type ReviewResult,
} from "../../features/ask-codex/review-result.ts";
import {
  HandoffInterruptedError,
  interruptionFromSignal,
} from "../harness-interruption.ts";
import {
  interruptWithin,
  settleWithin,
  waitForReviewOrInterruption,
} from "./interruptible-review.ts";
import { JsonRpcConnection } from "./json-rpc-connection.ts";
import {
  codexLifecycleMessageSchema,
  dynamicToolCallSchema,
  dynamicToolCompletedSchema,
  modelListResponseSchema,
  threadOpenResponseSchema,
  turnStartResponseSchema,
  turnInterruptResponseSchema,
  type RpcMessage,
} from "./protocol.ts";
import { createCodexProcessTransport } from "./process-transport.ts";

export type CodexReviewInput = {
  cwd: string;
  prompt: string;
  outputSchema: unknown;
  model?: string;
  nativeSessionId?: string;
  onNativeSessionOpened: (nativeSessionId: string) => Promise<void>;
  onNativeSessionInvalidated?: () => Promise<void>;
  onProviderMessage?: (message: unknown) => void;
  onApprovalRequired?: (method: string) => Promise<void>;
  onProgress: (text: string) => void;
  signal?: AbortSignal;
  dynamicTool?: CodexDynamicTool;
};

export type CodexDynamicTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  execute(argumentsValue: unknown): Promise<string>;
};

const initializeResponseSchema = z.object({ userAgent: z.string() });

type DynamicToolResponse = {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
};

type DynamicToolBridge = {
  tool: CodexDynamicTool;
  signal?: AbortSignal;
  respond(id: string | number, response: DynamicToolResponse): Promise<void>;
  onCallStarted?(callId: string): void;
  onCallAcknowledged?(callId: string): void;
};

/** Starts or resumes one read-only Codex review in a fresh app-server process. */
export async function runCodexReview(
  input: CodexReviewInput,
): Promise<ReviewResult> {
  const connection = new JsonRpcConnection(
    createCodexProcessTransport(input.cwd, input.onProgress),
    input.onProviderMessage,
  );

  let activeTurn: { threadId: string; turnId: string } | undefined;
  let pendingDynamicToolCall:
    | {
        callId: string;
        acknowledged: Promise<void>;
        acknowledge(): void;
      }
    | undefined;
  const startDynamicToolCall = (callId: string) => {
    const acknowledgement = Promise.withResolvers<void>();
    pendingDynamicToolCall = {
      callId,
      acknowledged: acknowledgement.promise,
      acknowledge: acknowledgement.resolve,
    };
  };
  const acknowledgeDynamicToolCall = (callId: string) => {
    if (pendingDynamicToolCall?.callId !== callId) {
      return;
    }

    pendingDynamicToolCall.acknowledge();
    pendingDynamicToolCall = undefined;
  };
  const interrupt = async (turn: { threadId: string; turnId: string }) => {
    await connection.request(
      "turn/interrupt",
      turn,
      turnInterruptResponseSchema,
    );
  };
  const review = async () => {
    await connection.request(
      "initialize",
      {
        clientInfo: { name: "passoff", title: "Passoff", version: "0.0.0" },
        capabilities: input.dynamicTool
          ? { experimentalApi: true, requestAttestation: false }
          : null,
      },
      initializeResponseSchema,
    );
    await connection.notify("initialized", {});

    const models = await loadAvailableModels(connection);
    const modelOverride = modelForThreadOpen(models, input);
    const openedThread = await openThread(connection, input, modelOverride);
    const model = openedThread.model;

    if (!models.some((candidate) => candidate.model === model)) {
      throw new Error(`Codex session uses unavailable model ${model}.`);
    }

    // Persisting here keeps the thread resumable even if the turn later fails.
    await input.onNativeSessionOpened(openedThread.id);

    input.onProgress(
      `${input.nativeSessionId ? "Resumed" : "Starting"} Codex review with ${model}.\n`,
    );

    const startedTurn = await connection.request(
      "turn/start",
      {
        threadId: openedThread.id,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        cwd: input.cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        model,
        outputSchema: input.outputSchema,
      },
      turnStartResponseSchema,
    );
    activeTurn = { threadId: openedThread.id, turnId: startedTurn.turn.id };

    const result = await collectReviewResult(
      () => connection.nextServerMessage(),
      input.onProgress,
      input.onApprovalRequired,
      input.dynamicTool
        ? {
            tool: input.dynamicTool,
            signal: input.signal,
            respond: (id, response) => connection.respond(id, response),
            onCallStarted: startDynamicToolCall,
            onCallAcknowledged: acknowledgeDynamicToolCall,
          }
        : undefined,
    );

    if (result.status === "blocked") {
      await interruptWithin(activeTurn, interrupt);
    }

    return result;
  };

  const reviewPromise = review();

  try {
    try {
      return await waitForReviewOrInterruption({
        review: reviewPromise,
        signal: input.signal,
        activeTurn: () => activeTurn,
        beforeInterrupt: async () => {
          // A native thread persists dynamic-tool calls. Let Codex acknowledge
          // the failed result before interruption so resumed threads stay valid.
          const acknowledgement = pendingDynamicToolCall?.acknowledged;

          if (acknowledgement) {
            const acknowledged = await settleWithin(acknowledgement, 1_000);

            if (!acknowledged) {
              input.onProgress(
                "Codex did not acknowledge the interrupted tool call; its outer session will be replaced.\n",
              );
              await input.onNativeSessionInvalidated?.();
            }
          }
        },
        interrupt,
      });
    } catch (error) {
      // The native interrupted event may arrive before turn/interrupt replies.
      // Preserve the caller's deadline or signal as the terminal reason.
      if (input.signal?.aborted) {
        await connection.close();
        // Closing rejects pending protocol work. Drain it so session callbacks
        // finish before run history writes the interrupted terminal record.
        await reviewPromise.catch(() => undefined);
        throw interruptionFromSignal(input.signal);
      }

      throw error;
    }
  } finally {
    await connection.close();
  }
}

async function openThread(
  connection: JsonRpcConnection,
  input: CodexReviewInput,
  model: string | undefined,
): Promise<{ id: string; model: string }> {
  const restrictions = {
    cwd: input.cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
    ...(model ? { model } : {}),
  } as const;

  if (!input.nativeSessionId) {
    if (!model) {
      throw new Error("Codex app-server did not report a default model.");
    }

    let response: z.infer<typeof threadOpenResponseSchema>;

    try {
      response = await connection.request(
        "thread/start",
        {
          ...restrictions,
          ...(input.dynamicTool
            ? { dynamicTools: [dynamicToolSpec(input.dynamicTool)] }
            : {}),
        },
        threadOpenResponseSchema,
      );
    } catch (error) {
      if (!input.dynamicTool) {
        throw error;
      }

      const detail = error instanceof Error ? error.message : "unknown error";
      throw new Error(
        `Codex could not register the experimental ${input.dynamicTool.name} tool: ${detail}`,
      );
    }

    return { id: response.thread.id, model: response.model };
  }

  try {
    const response = await connection.request(
      "thread/resume",
      {
        threadId: input.nativeSessionId,
        ...restrictions,
        excludeTurns: true,
      },
      threadOpenResponseSchema,
    );

    return { id: response.thread.id, model: response.model };
  } catch (error) {
    throw new Error(
      "The stored Codex session could not be resumed. It may no longer exist.",
      { cause: error },
    );
  }
}

function dynamicToolSpec(tool: CodexDynamicTool) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  } as const;
}

type AvailableModel = z.infer<typeof modelListResponseSchema>["data"][number];

async function loadAvailableModels(
  connection: JsonRpcConnection,
): Promise<AvailableModel[]> {
  // The catalog check catches stale CLIs and unavailable configured models
  // before we create a thread that cannot run.
  const models: AvailableModel[] = [];
  let cursor: string | null = null;

  do {
    const page: z.infer<typeof modelListResponseSchema> = await connection.request(
      "model/list",
      { cursor, limit: 100, includeHidden: true },
      modelListResponseSchema,
    );
    models.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor !== null);

  return models;
}

function modelForThreadOpen(
  models: AvailableModel[],
  input: Pick<CodexReviewInput, "model" | "nativeSessionId">,
): string | undefined {
  if (!input.nativeSessionId) {
    return selectModel(models, input.model);
  }

  // Omitting model on resume preserves the model stored by Codex. An explicit
  // --model still acts as an intentional override after catalog validation.
  return input.model ? selectModel(models, input.model) : undefined;
}

function selectModel(
  models: AvailableModel[],
  requestedModel: string | undefined,
): string {
  const match = requestedModel
    ? models.find(
        (candidate) =>
          candidate.id === requestedModel || candidate.model === requestedModel,
      )
    : models.find((candidate) => candidate.isDefault);

  if (match) {
    return match.model;
  }

  if (requestedModel) {
    throw new Error(`Codex model ${requestedModel} is not available.`);
  }

  throw new Error("Codex app-server did not report a default model.");
}

export async function collectReviewResult(
  nextMessage: () => Promise<RpcMessage>,
  onProgress: (text: string) => void = () => undefined,
  onApprovalRequired: (method: string) => Promise<void> = async () => undefined,
  dynamicTool?: DynamicToolBridge,
): Promise<ReviewResult> {
  // Structured turns may emit commentary agent messages. Only final_answer is
  // the review payload, and it is not trusted until the turn itself completes.
  let finalAnswer: string | undefined;
  let reportedInspection = false;

  while (true) {
    const message = await nextMessage();

    if (message.id !== undefined) {
      const toolCall = dynamicToolCallSchema.safeParse(message);

      if (toolCall.success && dynamicTool?.tool.name === toolCall.data.params.tool) {
        dynamicTool.onCallStarted?.(toolCall.data.params.callId);
        const response = answerDynamicToolCall(
          toolCall.data.id,
          toolCall.data.params.arguments,
          dynamicTool,
        );
        await response;

        continue;
      }

      await onApprovalRequired(message.method);

      return {
        status: "blocked",
        summary: `Codex requested host action ${message.method}; read-only reviews cannot approve requests.`,
        findings: [],
        checks: [],
      };
    }

    const completedTool = dynamicToolCompletedSchema.safeParse(message);

    if (completedTool.success) {
      dynamicTool?.onCallAcknowledged?.(completedTool.data.params.item.id);
      continue;
    }

    const lifecycle = codexLifecycleMessageSchema.safeParse(message);

    if (!lifecycle.success) {
      continue;
    }

    if (lifecycle.data.method === "error") {
      if (lifecycle.data.params.willRetry) {
        onProgress(
          `Codex encountered a temporary error and will retry: ${lifecycle.data.params.error.message}\n`,
        );
        continue;
      }

      throw new Error(
        `Codex review failed: ${lifecycle.data.params.error.message}`,
      );
    }

    if (lifecycle.data.method === "item/completed") {
      const item = lifecycle.data.params.item;

      if (
        item.type === "agentMessage" &&
        item.phase === "final_answer" &&
        typeof item.text === "string"
      ) {
        finalAnswer = item.text;
      } else if (item.type === "commandExecution" && !reportedInspection) {
        reportedInspection = true;
        onProgress("Codex inspected the repository.\n");
      }

      continue;
    }

    const { turn } = lifecycle.data.params;

    if (turn.status !== "completed") {
      if (turn.status === "interrupted") {
        throw new HandoffInterruptedError(
          turn.error?.message ?? "Codex reported that the review was interrupted.",
          "native_interruption",
          1,
        );
      }

      throw new Error(
        turn.error?.message ?? `Codex review ended with status ${turn.status}.`,
      );
    }

    if (!finalAnswer) {
      throw new Error("Codex completed without a final review result.");
    }

    return parseReviewResult(finalAnswer);
  }
}

async function answerDynamicToolCall(
  id: string | number,
  argumentsValue: unknown,
  bridge: DynamicToolBridge,
): Promise<void> {
  const outcome = await dynamicToolOutcome(
    bridge.tool,
    argumentsValue,
    bridge.signal,
  );

  try {
    await bridge.respond(id, {
      contentItems: [{ type: "inputText", text: outcome.text }],
      success: outcome.success,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Codex dynamic-tool protocol failed: ${detail}`);
  }
}

type DynamicToolOutcome = {
  text: string;
  success: boolean;
};

async function dynamicToolOutcome(
  tool: CodexDynamicTool,
  argumentsValue: unknown,
  signal: AbortSignal | undefined,
): Promise<DynamicToolOutcome> {
  // Convert provider failures into tool results so Codex always receives the
  // response required to keep its persisted thread resumable.
  const execution = tool.execute(argumentsValue).then(
    (text): DynamicToolOutcome => ({ text, success: true }),
    (error: unknown): DynamicToolOutcome => ({
      text: error instanceof Error ? error.message : "Claude handoff failed.",
      success: false,
    }),
  );

  if (!signal) {
    return execution;
  }

  if (signal.aborted) {
    return interruptedToolOutcome(signal);
  }

  let onAbort: () => void = () => undefined;
  const interrupted = new Promise<DynamicToolOutcome>((resolve) => {
    onAbort = () => resolve(interruptedToolOutcome(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([execution, interrupted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function interruptedToolOutcome(signal: AbortSignal): DynamicToolOutcome {
  return {
    text: interruptionFromSignal(signal).message,
    success: false,
  };
}
