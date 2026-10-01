import { beforeEach, describe, expect, it } from "vitest";
import { createFakeMidi } from "@/test/fakeMidi";
import {
  createMidiAccess,
  MIDI_STORAGE_KEY,
  parseMidiMessage,
  type MidiEvent,
} from "./access";

const KEYSTEP = { id: "k1", name: "KeyStep" };

beforeEach(() => localStorage.clear());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("midi access", () => {
  it("lists All inputs and the device after access is granted, without asking for sysex", async () => {
    const fake = createFakeMidi({ inputs: [KEYSTEP] });
    const access = createMidiAccess({ requestMIDIAccess: fake.requestMIDIAccess });
    expect(access.status).toBe("prompt");
    expect(fake.requests).toHaveLength(0);

    await access.request();

    expect(fake.requests).toEqual([{ sysex: false }]);
    expect(access.status).toBe("granted");
    expect(access.inputs).toEqual([KEYSTEP]);
    expect(access.selected).toBe("all");
  });

  it("reports unsupported when the browser has no Web MIDI", async () => {
    const access = createMidiAccess({ requestMIDIAccess: undefined });
    expect(access.status).toBe("unsupported");
    await access.request();
    expect(access.status).toBe("unsupported");
  });

  it("reports denied when the user refuses", async () => {
    const fake = createFakeMidi({ deny: true });
    const access = createMidiAccess({ requestMIDIAccess: fake.requestMIDIAccess });
    await access.request();
    expect(access.status).toBe("denied");
    expect(JSON.parse(localStorage.getItem(MIDI_STORAGE_KEY)!).granted).toBe(false);
  });

  it("adds a hot-plugged input and drops an unplugged one", async () => {
    const fake = createFakeMidi({ inputs: [KEYSTEP] });
    const access = createMidiAccess({ requestMIDIAccess: fake.requestMIDIAccess });
    await access.request();

    fake.connect("k2", "Launchkey");
    expect(access.inputs.map((i) => i.name)).toEqual(["KeyStep", "Launchkey"]);
    fake.disconnect("k2");
    expect(access.inputs.map((i) => i.name)).toEqual(["KeyStep"]);
  });

  it("notifies state subscribers on changes", async () => {
    const fake = createFakeMidi({ inputs: [KEYSTEP] });
    const access = createMidiAccess({ requestMIDIAccess: fake.requestMIDIAccess });
    let calls = 0;
    access.subscribeState(() => (calls += 1));
    await access.request();
    expect(calls).toBeGreaterThan(0);
  });

  it("flags a disconnected chosen input and resumes when it returns", async () => {
    const fake = createFakeMidi({ inputs: [KEYSTEP] });
    const access = createMidiAccess({ requestMIDIAccess: fake.requestMIDIAccess });
    await access.request();
    access.select("k1");
    const events: MidiEvent[] = [];
    access.subscribe((e) => events.push(e));

    fake.disconnect("k1");
    expect(access.getSnapshot().selectedConnected).toBe(false);
    expect(access.selected).toBe("k1");

    fake.connect("k1");
    expect(access.getSnapshot().selectedConnected).toBe(true);
    fake.send("k1", [0x90, 60, 100]);
    expect(events.map((e) => e.type)).toEqual(["reset", "on"]);
  });

  it("tells listeners to release held notes when the selection changes", async () => {
    const fake = createFakeMidi({ inputs: [KEYSTEP, { id: "k2", name: "Other" }] });
    const access = createMidiAccess({ requestMIDIAccess: fake.requestMIDIAccess });
    await access.request();
    const events: MidiEvent[] = [];
    access.subscribe((e) => events.push(e));

    access.select("k2");
    expect(events.map((e) => e.type)).toEqual(["reset"]);
    access.select("k2");
    expect(events).toHaveLength(1);
  });

  it("tells listeners to release held notes when a listened-to input unplugs", async () => {
    const fake = createFakeMidi({ inputs: [KEYSTEP, { id: "k2", name: "Other" }] });
    const access = createMidiAccess({ requestMIDIAccess: fake.requestMIDIAccess });
    await access.request();
    access.select("k1");
    const events: MidiEvent[] = [];
    access.subscribe((e) => events.push(e));

    fake.disconnect("k2");
    expect(events).toEqual([]);
    fake.disconnect("k1");
    expect(events.map((e) => e.type)).toEqual(["reset"]);
  });

  it("only forwards messages from the chosen input", async () => {
    const fake = createFakeMidi({ inputs: [KEYSTEP, { id: "k2", name: "Other" }] });
    const access = createMidiAccess({ requestMIDIAccess: fake.requestMIDIAccess });
    await access.request();
    const events: MidiEvent[] = [];
    access.subscribe((e) => events.push(e));

    fake.send("k1", [0x90, 60, 100]);
    fake.send("k2", [0x90, 62, 100]);
    expect(events.map((e) => e.note)).toEqual([60, 62]);

    access.select("k2");
    fake.send("k1", [0x90, 64, 100]);
    fake.send("k2", [0x90, 65, 100]);
    expect(events.filter((e) => e.type === "on").map((e) => e.note)).toEqual([60, 62, 65]);
  });

  it("stops forwarding after unsubscribe", async () => {
    const fake = createFakeMidi({ inputs: [KEYSTEP] });
    const access = createMidiAccess({ requestMIDIAccess: fake.requestMIDIAccess });
    await access.request();
    const events: MidiEvent[] = [];
    const off = access.subscribe((e) => events.push(e));
    off();
    fake.send("k1", [0x90, 60, 100]);
    expect(events).toEqual([]);
  });

  it("remembers the grant and the chosen input, and restores them without a gesture", async () => {
    const first = createFakeMidi({ inputs: [KEYSTEP] });
    const a = createMidiAccess({ requestMIDIAccess: first.requestMIDIAccess });
    await a.request();
    a.select("k1");
    expect(JSON.parse(localStorage.getItem(MIDI_STORAGE_KEY)!)).toEqual({
      granted: true,
      inputId: "k1",
    });

    const second = createFakeMidi({ inputs: [KEYSTEP] });
    const b = createMidiAccess({
      requestMIDIAccess: second.requestMIDIAccess,
      queryPermission: async () => "granted",
    });
    expect(second.requests).toHaveLength(0);
    b.subscribeState(() => {});
    await flush();
    expect(second.requests).toHaveLength(1);
    expect(b.status).toBe("granted");
    expect(b.selected).toBe("k1");
  });

  it("does not call requestMIDIAccess on load while the browser still has to prompt", async () => {
    localStorage.setItem(MIDI_STORAGE_KEY, JSON.stringify({ granted: true, inputId: "all" }));
    const fake = createFakeMidi({ inputs: [KEYSTEP] });
    const access = createMidiAccess({
      requestMIDIAccess: fake.requestMIDIAccess,
      queryPermission: async () => "prompt",
    });
    access.subscribeState(() => {});
    await flush();
    expect(fake.requests).toHaveLength(0);
    expect(access.status).toBe("prompt");
    expect(JSON.parse(localStorage.getItem(MIDI_STORAGE_KEY)!).granted).toBe(true);
  });

  it("stays at prompt when the permission query throws", async () => {
    localStorage.setItem(MIDI_STORAGE_KEY, JSON.stringify({ granted: true, inputId: "all" }));
    const fake = createFakeMidi({ inputs: [KEYSTEP] });
    const access = createMidiAccess({
      requestMIDIAccess: fake.requestMIDIAccess,
      queryPermission: () => Promise.reject(new TypeError("unsupported")),
    });
    access.subscribeState(() => {});
    await flush();
    expect(fake.requests).toHaveLength(0);
    expect(access.status).toBe("prompt");
  });

  it("does not request access on load when nothing was remembered", async () => {
    const fake = createFakeMidi({ inputs: [KEYSTEP] });
    createMidiAccess({ requestMIDIAccess: fake.requestMIDIAccess });
    await flush();
    expect(fake.requests).toHaveLength(0);
  });
});

describe("parseMidiMessage", () => {
  it("parses note-on and note-off on all 16 channels", () => {
    for (let ch = 0; ch < 16; ch++) {
      expect(parseMidiMessage([0x90 | ch, 60, 90], 5)).toEqual({
        type: "on",
        note: 60,
        velocity: 90,
        timeStamp: 5,
      });
      expect(parseMidiMessage([0x80 | ch, 60, 40], 5)).toEqual({
        type: "off",
        note: 60,
        velocity: 40,
        timeStamp: 5,
      });
      expect(parseMidiMessage([0xb0 | ch, 64, 127], 5)?.type).toBe("sustain");
    }
  });

  it("treats a velocity-0 note-on as a note-off", () => {
    expect(parseMidiMessage([0x90, 60, 0], 1)?.type).toBe("off");
  });

  it("carries the pedal value on sustain events", () => {
    expect(parseMidiMessage([0xb0, 64, 63], 1)).toMatchObject({ type: "sustain", velocity: 63 });
  });

  it("parses all-sound-off and all-notes-off as a reset", () => {
    expect(parseMidiMessage([0xb0, 120, 0], 1)?.type).toBe("reset");
    expect(parseMidiMessage([0xb3, 123, 0], 1)?.type).toBe("reset");
  });

  it("drops everything else", () => {
    expect(parseMidiMessage([0xb0, 1, 50], 0)).toBeNull();
    expect(parseMidiMessage([0xe0, 0, 64], 0)).toBeNull();
    expect(parseMidiMessage([0xc0, 5], 0)).toBeNull();
    expect(parseMidiMessage([0xf8], 0)).toBeNull();
  });
});
