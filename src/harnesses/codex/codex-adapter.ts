import { z } from "zod";

import {
  parseReviewResult,
  type ReviewResult,
} from "../../features/ask-codex/review-result.ts";
import { JsonRpcConnection } from "./json-rpc-connection.ts";
import {
  codexLifecycleMessageSchema,
  modelListResponseSchema,
  threadOpenResponseSchema,
  turnStartResponseSchema,
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
  onProgress: (text: string) => void;
};

const initializeResponseSchema = z.object({ userAgent: z.string() });

/** Starts or resumes one read-only Codex review in a fresh app-server process. */
export async function runCodexReview(
  input: CodexReviewInput,
): Promise<ReviewResult> {
  const connection = new JsonRpcConnection(
    createCodexProcessTransport(input.cwd, input.onProgress),
  );

  try {
    await connection.request(
      "initialize",
      {
        clientInfo: { name: "passoff", title: "Passoff", version: "0.0.0" },
        capabilities: null,
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

    await connection.request(
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

    return await collectReviewResult(
      () => connection.nextServerMessage(),
      input.onProgress,
    );
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

    const response = await connection.request(
      "thread/start",
      restrictions,
      threadOpenResponseSchema,
    );

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
): Promise<ReviewResult> {
  // Structured turns may emit commentary agent messages. Only final_answer is
  // the review payload, and it is not trusted until the turn itself completes.
  let finalAnswer: string | undefined;
  let reportedInspection = false;

  while (true) {
    const message = await nextMessage();

    if (message.id !== undefined) {
      throw new Error(
        `Codex requested host action ${message.method}; read-only reviews cannot approve requests.`,
      );
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
