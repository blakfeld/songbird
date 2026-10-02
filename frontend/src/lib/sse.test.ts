import { describe, expect, it } from "vitest";
import { parseSse, type SseMessage } from "./sse";

const encoder = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(chunks: Uint8Array[]): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const message of parseSse(streamOf(chunks))) out.push(message);
  return out;
}

async function parseWholeAndSplit(text: string): Promise<SseMessage[]> {
  const bytes = encoder.encode(text);
  const whole = await collect([bytes]);
  for (let i = 0; i <= bytes.length; i++) {
    const split = await collect([bytes.slice(0, i), bytes.slice(i)]);
    expect(split, `split at ${i}`).toEqual(whole);
  }
  const bytewise = await collect(Array.from(bytes, (b) => Uint8Array.of(b)));
  expect(bytewise).toEqual(whole);
  return whole;
}

describe("parseSse", () => {
  it("parses named events and defaults the name to message", async () => {
    const out = await parseWholeAndSplit(
      'event: stage\ndata: {"a":1}\n\ndata:x\n\n',
    );
    expect(out).toEqual([
      { event: "stage", data: '{"a":1}' },
      { event: "message", data: "x" },
    ]);
  });

  it("handles CRLF, CR and LF line endings", async () => {
    for (const eol of ["\r\n", "\r", "\n"]) {
      const out = await parseWholeAndSplit(
        `event: a${eol}data: 1${eol}${eol}data: 2${eol}${eol}`,
      );
      expect(out).toEqual([
        { event: "a", data: "1" },
        { event: "message", data: "2" },
      ]);
    }
  });

  it("joins multi-line data with newlines", async () => {
    const out = await parseWholeAndSplit("data: a\ndata:\ndata: b\n\n");
    expect(out).toEqual([{ event: "message", data: "a\n\nb" }]);
  });

  it("strips only one space after the colon", async () => {
    const out = await parseWholeAndSplit("data:  two\n\n");
    expect(out).toEqual([{ event: "message", data: " two" }]);
  });

  it("ignores keepalive comments", async () => {
    const out = await parseWholeAndSplit(
      ": keepalive\n\n: another\n\nevent: x\n: mid\ndata: y\n\n",
    );
    expect(out).toEqual([{ event: "x", data: "y" }]);
  });

  it("keeps multi-byte characters split across chunks", async () => {
    const out = await parseWholeAndSplit("data: héllo ♪ 🎵\n\n");
    expect(out).toEqual([{ event: "message", data: "héllo ♪ 🎵" }]);
  });

  it("discards an event the stream ends in the middle of", async () => {
    const out = await parseWholeAndSplit("data: done\n\nevent: x\ndata: part");
    expect(out).toEqual([{ event: "message", data: "done" }]);
  });

  it("does not dispatch events without data", async () => {
    const out = await parseWholeAndSplit("event: x\n\ndata: y\n\n");
    expect(out).toEqual([{ event: "message", data: "y" }]);
  });
});
