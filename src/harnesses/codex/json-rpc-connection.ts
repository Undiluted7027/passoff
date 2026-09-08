import type { ZodType } from "zod";

import {
  rpcMessageSchema,
  rpcResponseSchema,
  type RpcMessage,
} from "./protocol.ts";

export interface RpcTransport {
  readonly messages: AsyncIterable<unknown>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

/** Buffers provider notifications that can arrive between request responses. */
class ServerMessageQueue {
  readonly #messages: RpcMessage[] = [];
  readonly #waiters: Array<{
    resolve(message: RpcMessage): void;
    reject(error: Error): void;
  }> = [];
  #error: Error | undefined;

  push(message: RpcMessage): void {
    const waiter = this.#waiters.shift();

    if (waiter) {
      waiter.resolve(message);
    } else {
      this.#messages.push(message);
    }
  }

  fail(error: Error): void {
    this.#error = error;

    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  async next(): Promise<RpcMessage> {
    const message = this.#messages.shift();

    if (message) {
      return message;
    }

    if (this.#error) {
      throw this.#error;
    }

    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }
}

export class JsonRpcConnection {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #serverMessages = new ServerMessageQueue();
  #nextId = 0;
  readonly #reader: Promise<void>;
  #failure: Error | undefined;
  #closing: Promise<void> | undefined;

  constructor(
    private readonly transport: RpcTransport,
    private readonly onProviderMessage: (message: unknown) => void = () =>
      undefined,
  ) {
    this.#reader = this.readMessages();
  }

  async request<T>(method: string, params: unknown, schema: ZodType<T>): Promise<T> {
    if (this.#failure) {
      throw this.#failure;
    }

    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(String(id), { resolve, reject });
    });

    try {
      await this.transport.send({ method, id, params });
    } catch (error) {
      this.#pending.delete(String(id));
      throw error;
    }

    return schema.parse(await response);
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.#failure) {
      throw this.#failure;
    }

    await this.transport.send({ method, params });
  }

  /** Replies to a request initiated by app-server using the same request ID. */
  async respond(id: string | number, result: unknown): Promise<void> {
    if (this.#failure) {
      throw this.#failure;
    }

    await this.transport.send({ id, result });
  }

  nextServerMessage(): Promise<RpcMessage> {
    return this.#serverMessages.next();
  }

  close(): Promise<void> {
    this.#closing ??= this.closeTransport();
    return this.#closing;
  }

  private async closeTransport(): Promise<void> {
    await this.transport.close();
    await this.#reader.catch(() => undefined);
  }

  /** Routes responses to their request and leaves notifications for the adapter. */
  private async readMessages(): Promise<void> {
    try {
      for await (const value of this.transport.messages) {
        this.onProviderMessage(value);
        const response = rpcResponseSchema.safeParse(value);

        if (response.success && !("method" in response.data)) {
          const pending = this.#pending.get(String(response.data.id));

          if (!pending) {
            throw new Error(
              `Codex app-server replied to unknown request ${response.data.id}.`,
            );
          }

          this.#pending.delete(String(response.data.id));

          if (response.data.error) {
            pending.reject(
              new Error(`Codex app-server: ${response.data.error.message}`),
            );
          } else {
            pending.resolve(response.data.result);
          }

          continue;
        }

        this.#serverMessages.push(rpcMessageSchema.parse(value));
      }

      throw new Error("Codex app-server closed before the review completed.");
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("Codex app-server failed.");
      this.#failure = failure;

      for (const pending of this.#pending.values()) {
        pending.reject(failure);
      }

      this.#pending.clear();
      this.#serverMessages.fail(failure);
    }
  }
}
