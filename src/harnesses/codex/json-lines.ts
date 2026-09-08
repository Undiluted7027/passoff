/** Reads newline-delimited JSON without assuming process chunks align to lines. */
export async function* readJsonLines(
  chunks: AsyncIterable<Uint8Array | string>,
  source = "Codex app-server",
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
        yield parseLine(line, source);
      }
    }
  }

  pending += decoder.decode();

  if (pending.trim() !== "") {
    yield parseLine(pending, source);
  }
}

function parseLine(line: string, source: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${source} wrote malformed JSON to stdout.`);
  }
}
