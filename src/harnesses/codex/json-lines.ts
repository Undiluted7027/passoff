/** Reads newline-delimited JSON without assuming process chunks align to lines. */
export async function* readJsonLines(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let pending = "";

  for await (const chunk of chunks) {
    pending +=
      typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

    const lines = pending.split("\n");
    pending = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim() !== "") {
        yield parseLine(line);
      }
    }
  }

  pending += decoder.decode();

  if (pending.trim() !== "") {
    yield parseLine(pending);
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error("Codex app-server wrote malformed JSON to stdout.");
  }
}
