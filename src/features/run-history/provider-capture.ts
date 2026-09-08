import type { JsonValue } from "./run-record.ts";

const maxCapturedMessages = 256;
const maxCapturedBytes = 256 * 1024;
const maxMessageCharacters = 64 * 1024;
const maxValueDepth = 20;

const sensitiveProviderKey =
  /(authorization|cookie|password|secret|token|api[_-]?key|environment|^env$)/i;

/** Keeps opt-in provider diagnostics useful without letting them grow forever. */
export class ProviderCapture {
  readonly #messages: JsonValue[] = [];
  readonly #encoder = new TextEncoder();
  #capturedBytes = 0;
  #omittedMessages = 0;
  #closed = false;

  add(value: unknown): void {
    if (this.#closed) {
      this.#omittedMessages += 1;
      return;
    }

    const message = sanitizeProviderValue(value);
    const messageBytes = this.#encoder.encode(JSON.stringify(message)).byteLength;

    if (
      this.#messages.length >= maxCapturedMessages ||
      this.#capturedBytes + messageBytes > maxCapturedBytes
    ) {
      this.#omittedMessages += 1;
      this.#closed = true;
      return;
    }

    this.#messages.push(message);
    this.#capturedBytes += messageBytes;
  }

  values(): JsonValue[] {
    if (this.#omittedMessages === 0) {
      return [...this.#messages];
    }

    return [
      ...this.#messages,
      {
        type: "passoff.capture.truncated",
        omittedMessages: this.#omittedMessages,
      },
    ];
  }
}

/** Removes sensitive fields and bounds the copy made from one provider message. */
export function sanitizeProviderValue(value: unknown): JsonValue {
  const budget = { remainingCharacters: maxMessageCharacters };
  return sanitizeValue(value, budget, 0);
}

function sanitizeValue(
  value: unknown,
  budget: { remainingCharacters: number },
  depth: number,
): JsonValue {
  if (budget.remainingCharacters <= 0 || depth > maxValueDepth) {
    // Exhaust the shared budget so parent collections stop copying siblings.
    budget.remainingCharacters = 0;
    return "[capture truncated]";
  }

  if (typeof value === "string") {
    const kept = value.slice(0, budget.remainingCharacters);
    budget.remainingCharacters -= kept.length;
    return kept.length === value.length ? kept : `${kept}[capture truncated]`;
  }

  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    budget.remainingCharacters -= 1;
    return value;
  }

  if (Array.isArray(value)) {
    const sanitized: JsonValue[] = [];

    for (const child of value) {
      if (budget.remainingCharacters <= 0) {
        sanitized.push("[capture truncated]");
        break;
      }

      sanitized.push(sanitizeValue(child, budget, depth + 1));
    }

    return sanitized;
  }

  if (typeof value === "object") {
    const sanitized: { [key: string]: JsonValue } = {};

    for (const [key, child] of Object.entries(value)) {
      if (budget.remainingCharacters <= 0) {
        sanitized["passoff.capture"] = "[capture truncated]";
        break;
      }

      budget.remainingCharacters -= key.length;
      sanitized[key] = sensitiveProviderKey.test(key)
        ? "[redacted]"
        : sanitizeValue(child, budget, depth + 1);
    }

    return sanitized;
  }

  return "[unsupported value]";
}
