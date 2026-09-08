import type { ReviewResult } from "../../features/ask-codex/review-result.ts";
import {
  parseReviewResult,
  parseReviewResultValue,
} from "../../features/ask-codex/review-result.ts";
import {
  interruptionFromSignal,
  throwIfInterrupted,
} from "../harness-interruption.ts";
import { createClaudeProcess, type ClaudeProcess } from "./process.ts";
import { claudeStreamMessageSchema } from "./protocol.ts";

const REVIEW_TOOLS = "Read,Glob,Grep";

export type ClaudeReviewInput = {
  cwd: string;
  prompt: string;
  outputSchema: unknown;
  nativeSessionId?: string;
  onNativeSessionOpened: (nativeSessionId: string) => Promise<void>;
  onProviderMessage?: (message: unknown) => void;
  onApprovalRequired?: (method: string) => Promise<void>;
  onProgress: (text: string) => void;
  signal?: AbortSignal;
};

type ClaudeReviewDependencies = {
  startProcess?: (
    cwd: string,
    args: string[],
    onProgress: (text: string) => void,
  ) => ClaudeProcess;
};

/** Runs Claude Code in noninteractive read-only mode and validates its result. */
export async function runClaudeReview(
  input: ClaudeReviewInput,
  dependencies: ClaudeReviewDependencies = {},
): Promise<ReviewResult> {
  throwIfInterrupted(input.signal);
  const startProcess = dependencies.startProcess ?? createClaudeProcess;
  const process = startProcess(
    input.cwd,
    buildClaudeArguments(input),
    input.onProgress,
  );
  const messages = captureMessages(process.messages, input.onProviderMessage);
  const review = collectClaudeReview(messages, input);
  const onAbort = () => process.interrupt();
  const signal = input.signal;

  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });

    // Abort can race with process creation and listener registration.
    if (signal.aborted) {
      onAbort();
    }
  }

  try {
    const result = await review;
    throwIfInterrupted(input.signal);
    return result;
  } catch (error) {
    if (signal?.aborted) {
      await review.catch(() => undefined);
      throw interruptionFromSignal(signal);
    }

    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await process.close();
  }
}

export function buildClaudeArguments(
  input: Pick<
    ClaudeReviewInput,
    "prompt" | "outputSchema" | "nativeSessionId"
  >,
): string[] {
  return [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--json-schema",
    JSON.stringify(claudeCompatibleSchema(input.outputSchema)),
    "--restricted",
    "--strict-mcp-config",
    "--tools",
    REVIEW_TOOLS,
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    ...(input.nativeSessionId ? ["--resume", input.nativeSessionId] : []),
    input.prompt,
  ];
}

/** Claude accepts the schema body but rejects Zod's draft URI declaration. */
function claudeCompatibleSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }

  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "$schema"),
  );
}

type ClaudeReviewCallbacks = Pick<
  ClaudeReviewInput,
  "onNativeSessionOpened" | "onApprovalRequired"
> & {
  onProgress?: ClaudeReviewInput["onProgress"];
};

/** Reduces Claude's stream to the session ID, denials, and terminal result. */
export async function collectClaudeReview(
  messages: Iterable<unknown> | AsyncIterable<unknown>,
  callbacks: ClaudeReviewCallbacks,
): Promise<ReviewResult> {
  let openedSession = false;
  let reportedReviewing = false;
  const reportedTools = new Set<string>();

  const openSession = async (sessionId: string) => {
    if (openedSession) {
      return;
    }

    openedSession = true;
    await callbacks.onNativeSessionOpened(sessionId);
  };

  for await (const message of messages) {
    const parsed = claudeStreamMessageSchema.safeParse(message);

    if (!parsed.success) {
      continue;
    }

    if (parsed.data.type === "system") {
      await openSession(parsed.data.session_id);
      continue;
    }

    await openSession(parsed.data.session_id);

    if (parsed.data.type === "assistant") {
      if (!reportedReviewing) {
        reportedReviewing = true;
        callbacks.onProgress?.("Claude is reviewing.\n");
      }

      for (const block of parsed.data.message.content) {
        if (
          block.type === "tool_use" &&
          block.name !== undefined &&
          !reportedTools.has(block.name)
        ) {
          reportedTools.add(block.name);
          callbacks.onProgress?.(`Claude is using ${block.name}.\n`);
        }
      }

      continue;
    }

    if (parsed.data.permission_denials.length > 0) {
      const deniedTools = [
        ...new Set(parsed.data.permission_denials.map((denial) => denial.tool_name)),
      ];
      for (const tool of deniedTools) {
        await callbacks.onApprovalRequired?.(tool);
      }

      return {
        status: "blocked",
        summary: `Claude requested tools unavailable to read-only reviews: ${deniedTools.join(", ")}.`,
        checks: [],
        findings: [],
      };
    }

    if (parsed.data.is_error || parsed.data.subtype !== "success") {
      const detail = parsed.data.errors?.join(" ") || parsed.data.terminal_reason;
      throw new Error(`Claude review failed${detail ? `: ${detail}` : "."}`);
    }

    if (parsed.data.structured_output !== undefined) {
      return parseReviewResultValue(parsed.data.structured_output, "Claude");
    }

    if (parsed.data.result !== undefined) {
      return parseReviewResult(parsed.data.result, "Claude");
    }

    throw new Error("Claude completed without a final review result.");
  }

  throw new Error("Claude Code closed before returning a review result.");
}

async function* captureMessages(
  messages: AsyncIterable<unknown>,
  capture: ((message: unknown) => void) | undefined,
): AsyncGenerator<unknown> {
  for await (const message of messages) {
    capture?.(message);
    yield message;
  }
}
