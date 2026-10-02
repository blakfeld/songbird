export interface SseMessage {
  event: string;
  data: string;
}

const LINE_END = /\r\n|\r|\n/;

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];

  // The SSE spec dispatches nothing for an event without data, so a blank line only yields a message when data was seen.
  const handleLine = (line: string): SseMessage | null => {
    if (line === "") {
      const message =
        data.length > 0
          ? { event: event || "message", data: data.join("\n") }
          : null;
      event = "";
      data = [];
      return message;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      // stream: true keeps a multi-byte character split across chunks intact.
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      for (;;) {
        const match = LINE_END.exec(buffer);
        if (!match) break;
        // A trailing \r may be the first half of \r\n arriving in the next
        // chunk, but at end of stream it is a complete line ending.
        if (!done && match[0] === "\r" && match.index === buffer.length - 1) {
          break;
        }
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const message = handleLine(line);
        if (message) yield message;
      }
      if (done) return;
    }
  } finally {
    // Releases the connection when the consumer stops early.
    await reader.cancel().catch(() => undefined);
  }
}
