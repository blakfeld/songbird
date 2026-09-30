import { describe, expect, it, vi } from "vitest";
import { createDrumsSource } from "./drumsSource";

const h = vi.hoisted(() => ({
  connected: [] as unknown[],
  toDestinationCalls: 0,
}));

vi.mock("tone", () => ({}));

class Gain {
  constructor(public value: number) {}
  connect(node: unknown) {
    h.connected.push(node);
    return this;
  }
  toDestination() {
    h.toDestinationCalls += 1;
    return this;
  }
  dispose() {}
}
class ToneBufferSource {
  connect() {
    return this;
  }
  start() {}
  stop() {}
  dispose() {}
}
class ToneAudioBuffers {
  has() {
    return true;
  }
  get() {
    return {};
  }
}

const tone = { Gain, ToneBufferSource, ToneAudioBuffers, loaded: async () => {} } as never;
const row = { id: "kick", name: "Kick", midi_note: 36 };

describe("drums source routing", () => {
  it("connects hits to the supplied output and never to the destination", async () => {
    h.connected = [];
    h.toDestinationCalls = 0;
    const output = { name: "channel" } as never;
    const source = createDrumsSource(tone, output);
    await source.load([row]);
    source.trigger(row, 1, 2, 100);

    expect(h.connected).toEqual([output]);
    expect(h.toDestinationCalls).toBe(0);
  });

  it("plays to the destination when no output is supplied", async () => {
    h.connected = [];
    h.toDestinationCalls = 0;
    const source = createDrumsSource(tone);
    await source.load([row]);
    source.trigger(row, 1, 2, 100);

    expect(h.toDestinationCalls).toBe(1);
    expect(h.connected).toEqual([]);
  });
});
