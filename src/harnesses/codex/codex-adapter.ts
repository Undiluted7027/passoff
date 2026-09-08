import { z } from "zod";

import {
  parseReviewResult,
  type ReviewResult,
} from "../../features/ask-codex/review-result.ts";
import { JsonRpcConnection } from "./json-rpc-connection.ts";
import {
  codexLifecycleMessageSchema,
  modelListResponseSchema,
  threadStartResponseSchema,
  turnStartResponseSchema,
  type RpcMessage,
} from "./protocol.ts";
import { createCodexProcessTransport } from "./process-transport.ts";

type StartCodexReviewInput = {
  cwd: string;
  prompt: string;
  outputSchema: unknown;
  model?: string;
  onProgress: (text: string) => void;
};

const initializeResponseSchema = z.object({ userAgent: z.string() });

/** Starts one new, read-only Codex review and returns its validated result. */
export async function startCodexReview(
  input: StartCodexReviewInput,
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

    const model = await selectModel(connection, input.model);
    input.onProgress(`Starting Codex review with ${model}.\n`);

    const { thread } = await connection.request(
      "thread/start",
      {
        cwd: input.cwd,
        model,
        approvalPolicy: "never",
        sandbox: "read-only",
      },
      threadStartResponseSchema,
    );

    await connection.request(
      "turn/start",
      {
        threadId: thread.id,
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

async function selectModel(
  connection: JsonRpcConnection,
  requestedModel: string | undefined,
): Promise<string> {
  // The catalog check catches stale CLIs and unavailable configured models
  // before we create a thread that cannot run.
  let cursor: string | null = null;

  do {
    const page: z.infer<typeof modelListResponseSchema> = await connection.request(
      "model/list",
      { cursor, limit: 100, includeHidden: true },
      modelListResponseSchema,
    );
    const match = requestedModel
      ? page.data.find(
          (candidate) =>
            candidate.id === requestedModel || candidate.model === requestedModel,
        )
      : page.data.find((candidate) => candidate.isDefault);

    if (match) {
      return match.model;
    }

    cursor = page.nextCursor;
  } while (cursor !== null);

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
