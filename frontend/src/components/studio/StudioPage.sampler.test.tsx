import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clear, createStore } from "idb-keyval";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Row } from "@/generated/Row";
import type { Sample } from "@/generated/Sample";
import * as api from "@/lib/api";
import { createSamplerSource } from "@/lib/audio/samplerSource";
import { addToLibrary } from "@/lib/audio/sampleLibrary";
import { primeOverview } from "@/lib/audio/useSampleLibrary";
import { createMidiAccess } from "@/lib/midi/access";
import { addSamplerTrack, assignPad, chooseKeysSample } from "@/lib/song/samplerOps";
import { createServerSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import type { SongStore } from "@/lib/song/songStore";
import { newSong, type Song } from "@/lib/song/types";
import { createFakeMidi } from "@/test/fakeMidi";
import { createFakeProjectsApi } from "@/test/fakeProjectsApi";
import { drums } from "@/test/fixtures";
import { clearStoredValueCache } from "@/lib/useStoredValue";
import { SAMPLE_MIME } from "./samples/useSampleDrop";
import { StudioPage } from "./StudioPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
}));

const importFiles = vi.fn();
vi.mock("@/lib/audio/sampleImport", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio/sampleImport")>()),
  importAudioFiles: (...args: unknown[]) => importFiles(...args),
}));

// Just enough Web Audio for the real sampler source, so a MIDI key press can be followed to the rate it would play at.
const heard = vi.hoisted(() => ({ rates: [] as number[], starts: [] as number[] }));
const fakeTone = (() => {
  class Param {
    setValueAtTime() {}
    linearRampToValueAtTime() {}
    cancelScheduledValues() {}
    cancelAndHoldAtTime() {}
    rampTo() {}
  }
  class Gain {
    gain = new Param();
    connect() {
      return this;
    }
    disconnect() {
      return this;
    }
    dispose() {}
  }
  class Player {
    buffer: unknown;
    constructor(options: { playbackRate: number }) {
      heard.rates.push(options.playbackRate);
    }
    connect() {
      return this;
    }
    start(t: number) {
      heard.starts.push(t);
    }
    stop() {}
    dispose() {}
  }
  return { Gain, Player, Filter: Gain, getDestination: () => ({}), now: () => 0 } as never;
})();
const buffers = {
  load: async () => {},
  get: () => ({ duration: 2 }) as never,
  acquire() {},
  release() {},
};

// The engine has its own tests; here it is replaced by a real sampler source fed from the store, so what is checked
// is what the user set up in the UI, played at the pitch the source computes.
let liveStore: SongStore | null = null;
const sources = new Map<string, ReturnType<ReturnType<typeof createSamplerSource>>>();
const liveNoteOn = vi.fn((row: Row, options?: { voiceKey?: string; velocity?: number }) => {
  const track = liveStore?.getState().song?.tracks.find((t) => t.id === options?.voiceKey);
  if (!track) return null;
  let source = sources.get(track.id);
  if (!source) {
    source = createSamplerSource(track.instrument === "sampler-pads" ? "pads" : "keys")(fakeTone, {} as never);
    sources.set(track.id, source);
  }
  source.setSamples!(track.sampler ?? {}, buffers);
  return source.noteOn(row, 0, options?.velocity ?? 100);
});
const audition = vi.fn(async () => {});
vi.mock("@/lib/audio/useSongPlayback", () => ({
  useSongPlayback: (store: SongStore) => {
    liveStore = store;
    return {
      isPlaying: false,
      status: "idle",
      error: null,
      toggle: vi.fn(),
      stop: vi.fn(),
      seek: vi.fn(),
      preload: vi.fn(),
      subscribePosition: () => () => {},
      audition,
      engine: {
        prepareLive: vi.fn(async () => {}),
        liveNoteOn,
        liveNoteOff: vi.fn(),
        liveBlocked: vi.fn(() => false),
        startMeasure: vi.fn(() => 1),
        stepAt: vi.fn(() => null),
        play: vi.fn(async () => {}),
        stop: vi.fn(),
        setMetronome: vi.fn(),
        subscribeCountIn: () => () => {},
        subscribeCountInEnd: () => () => {},
      },
    };
  },
}));

const sample = (id: string, name: string): Sample => ({
  id,
  name,
  sample_rate: 48000,
  channels: 1,
  length_samples: 48000,
  origin: "import",
});
const entryOf = (s: Sample) => ({
  id: s.id,
  name: s.name,
  sampleRate: s.sample_rate,
  channels: s.channels,
  length: s.length_samples,
  importedAt: 1,
});

let library: SongLibrary;

// Every sample used here is primed as present, because a sample the browser never stored is shown as missing.
async function stock(...samples: Sample[]) {
  for (const s of samples) {
    primeOverview(s.id, new Float32Array([-0.5, 0.5]));
    await addToLibrary(entryOf(s));
  }
}

async function renderStudio(song: Song, props: Partial<Parameters<typeof StudioPage>[0]> = {}) {
  await library.create(song);
  render(<StudioPage library={library} {...props} />);
  await screen.findByRole("region", { name: "Arrangement" });
}

const samplerSong = (kind: "keys" | "pads") => addSamplerTrack(newSong("4/4", 120), kind)!;
const dock = () => screen.getByRole("region", { name: /^Editor:/ });
const padLabel = (name: string) => within(dock()).getByRole("button", { name });
const statusText = () => document.querySelector<HTMLElement>("p[role=status].min-h-5")!.textContent;

const libraryDrag = (id: string) => ({
  types: [SAMPLE_MIME],
  getData: (type: string) => (type === SAMPLE_MIME ? id : ""),
  files: [] as File[],
  items: [] as unknown[],
  dropEffect: "none",
});
const fileDrag = (files: File[]) => ({
  types: ["Files"],
  getData: () => "",
  files,
  items: files.map((f) => ({ kind: "file", type: f.type })),
  dropEffect: "none",
});

beforeAll(() => {
  if (!("DragEvent" in window)) Object.defineProperty(window, "DragEvent", { value: class DragEvent extends MouseEvent {}, configurable: true });
});

beforeEach(async () => {
  localStorage.clear();
  clearStoredValueCache();
  await clear();
  await clear(createStore("songbird-sample-library.test-user", "library"));
  library = createServerSongLibrary(createFakeProjectsApi().api);
  sources.clear();
  heard.rates.length = 0;
  heard.starts.length = 0;
  importFiles.mockReset();
  liveNoteOn.mockClear();
  vi.mocked(api.getInstruments).mockResolvedValue([drums] as InstrumentInfo[]);
});
afterEach(() => {
  cleanup();
});

describe("sampler tracks", () => {
  it("Add a pad sampler", async () => {
    await renderStudio(newSong("4/4", 120));
    await userEvent.click(screen.getByRole("button", { name: "Add track" }));
    // The samplers share the drums and melodic kinds but belong only to the Audio group.
    expect(within(screen.getByRole("group", { name: "Drums" })).queryByRole("menuitem", { name: /Sampler/ })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Audio" })).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Audio",
      "Sampler (keys)",
      "Sampler (pads)",
    ]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Sampler (pads)" }));

    expect(statusText()).toBe("Added a Pads track.");
    expect(screen.getByRole("button", { name: /^Select Pads track/ })).toBeInTheDocument();
    const labels = within(dock()).getAllByRole("button", { name: /^Pad \d+, empty$/ });
    expect(labels).toHaveLength(16);
    expect(labels[0]).toHaveTextContent("Pad 1");
    expect(labels[15]).toHaveTextContent("Pad 16");
    expect(screen.queryByRole("menuitem", { name: /Generate part with AI/ })).toBeNull();

    // The track, its loop and its clip go together, so one Undo removes all three.
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.queryByRole("button", { name: /^Select Pads track/ })).toBeNull();
  });

  it("numbers a second sampler of the same kind", async () => {
    await renderStudio(samplerSong("keys").song);
    await userEvent.click(screen.getByRole("button", { name: "Add track" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Sampler (keys)" }));
    expect(screen.getByRole("button", { name: /^Select Sampler 2 track/ })).toBeInTheDocument();
  });

  it("Drop a kick on a pad", async () => {
    const kick = sample("kick", "kick-808");
    await stock(kick);
    await renderStudio(samplerSong("pads").song);

    const row = padLabel("Pad 1, empty").closest("[data-pad-row]")!;
    fireEvent.dragOver(row, { dataTransfer: libraryDrag(kick.id) });
    fireEvent.drop(row, { dataTransfer: libraryDrag(kick.id) });

    const assigned = await screen.findByRole("button", { name: "Pad 1, kick-808" });
    expect(assigned).toHaveTextContent("kick-808");
    expect(statusText()).toBe("Pad 1 is now kick-808.");

    // One undo step: the assignment and the song's sample list go together.
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(padLabel("Pad 1, empty")).toBeInTheDocument();
  });

  it("Drop several files on a pad", async () => {
    const files = ["alpha", "beta", "gamma"].map((n) => sample(n, n));
    for (const s of files) primeOverview(s.id, new Float32Array([-0.5, 0.5]));
    importFiles.mockResolvedValue({
      lowStorage: false,
      outcomes: files.map((s) => ({ ok: true, file: `${s.name}.wav`, entry: entryOf(s), duplicate: false })),
    });
    await renderStudio(samplerSong("pads").song);

    const row = padLabel("Pad 14, empty").closest("[data-pad-row]")!;
    const dropped = files.map((s) => new File(["x"], `${s.name}.wav`, { type: "audio/wav" }));
    fireEvent.dragOver(row, { dataTransfer: fileDrag(dropped) });
    expect(screen.getByText("3 files → Pads 14–16")).toBeInTheDocument();
    fireEvent.drop(row, { dataTransfer: fileDrag(dropped) });

    await screen.findByRole("button", { name: "Pad 16, gamma" });
    expect(padLabel("Pad 14, alpha")).toBeInTheDocument();
    expect(padLabel("Pad 15, beta")).toBeInTheDocument();
    expect(statusText()).toBe("Pads 14 to 16 are now alpha, beta, gamma.");

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(padLabel("Pad 14, empty")).toBeInTheDocument();
    expect(padLabel("Pad 16, empty")).toBeInTheDocument();
  });

  it("stops a multi-file drop at pad 16 and says what was left out", async () => {
    const files = ["a", "b", "c"].map((n) => sample(n, n));
    for (const s of files) primeOverview(s.id, new Float32Array([-0.5, 0.5]));
    importFiles.mockResolvedValue({
      lowStorage: false,
      outcomes: files.map((s) => ({ ok: true, file: `${s.name}.wav`, entry: entryOf(s), duplicate: false })),
    });
    await renderStudio(samplerSong("pads").song);
    const row = padLabel("Pad 15, empty").closest("[data-pad-row]")!;
    fireEvent.drop(row, { dataTransfer: fileDrag(files.map((s) => new File(["x"], `${s.name}.wav`, { type: "audio/wav" }))) });
    await screen.findByRole("button", { name: "Pad 16, b" });
    expect(statusText()).toBe("Pads 15 to 16 are now a and b. 1 file didn't fit after Pad 16 and stay in the library.");
  });

  it("refuses a non-audio file on a pad", async () => {
    await renderStudio(samplerSong("pads").song);
    const row = padLabel("Pad 1, empty").closest("[data-pad-row]")!;
    const text = new File(["x"], "notes.txt", { type: "text/plain" });
    fireEvent.dragOver(row, { dataTransfer: fileDrag([text]) });
    expect(screen.getByText("⊘ Not an audio file")).toBeInTheDocument();
    fireEvent.drop(row, { dataTransfer: fileDrag([text]) });
    expect(importFiles).not.toHaveBeenCalled();
  });

  it("auditions a pad from its label and edits it from the settings dialog", async () => {
    const kick = sample("kick", "kick-808");
    await stock(kick);
    const added = samplerSong("pads");
    const song = assignPad(added.song, added.trackId, "pad-3", kick).song!;
    await renderStudio(song);

    await userEvent.click(padLabel("Pad 3, kick-808"));
    expect(audition).toHaveBeenCalledWith(expect.objectContaining({ id: "pad-3" }), expect.objectContaining({ voiceKey: added.trackId }));

    await userEvent.click(screen.getByRole("button", { name: "Pad 3 settings" }));
    const dialog = screen.getByRole("dialog", { name: "Pad 3: kick-808" });
    const gain = within(dialog).getByRole("slider", { name: "Pad 3 gain" });
    gain.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(gain).toHaveAttribute("aria-valuetext", "minus 1 decibels");
    expect(padLabel("Pad 3, kick-808")).toHaveAttribute("aria-description", "gain minus 1 decibel");

    await userEvent.click(within(dialog).getByRole("button", { name: "Clear pad" }));
    expect(screen.queryByRole("dialog", { name: /^Pad 3/ })).toBeNull();
    expect(padLabel("Pad 3, empty")).toBeInTheDocument();
    expect(statusText()).toBe("Cleared Pad 3.");
  });

  it("clears a pad with Delete and opens its settings with Shift+F10", async () => {
    const kick = sample("kick", "kick-808");
    await stock(kick);
    const added = samplerSong("pads");
    await renderStudio(assignPad(added.song, added.trackId, "pad-1", kick).song!);
    padLabel("Pad 1, kick-808").focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("dialog", { name: "Pad 1: kick-808" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /^Pad 1/ })).toBeNull();
    expect(padLabel("Pad 1, kick-808")).toHaveFocus();
    await userEvent.keyboard("{Delete}");
    expect(padLabel("Pad 1, empty")).toBeInTheDocument();
  });

  it("assigns a pad through the library picker", async () => {
    const snare = sample("snare", "snare");
    await stock(snare);
    await renderStudio(samplerSong("pads").song);
    padLabel("Pad 2, empty").focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await userEvent.click(screen.getByRole("button", { name: "Choose sample…" }));
    const picker = await screen.findByRole("dialog", { name: "Choose sample for Pad 2" });
    await userEvent.click(await within(picker).findByRole("button", { name: /^snare, / }));
    expect(await screen.findByRole("button", { name: "Pad 2, snare" })).toBeInTheDocument();
  });
});

describe("when the instrument list cannot be loaded", () => {
  it("still opens a sampler track and offers the sampler entries", async () => {
    vi.mocked(api.getInstruments).mockRejectedValue(new Error("down"));
    await renderStudio(samplerSong("pads").song);
    expect(await screen.findByRole("button", { name: "Pad 1, empty" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add track" }));
    expect(screen.getByRole("menuitem", { name: "Sampler (keys)" })).toBeInTheDocument();
    expect(screen.getAllByText("Couldn't load instruments.").length).toBeGreaterThan(0);
    // The sampler's own surfaces name it properly and show no failure above its working roll.
    expect(screen.getByRole("button", { name: /^Select Pads track \(Sampler \(pads\)\)/ })).toBeInTheDocument();
    expect(within(dock()).queryByText("Couldn't load instruments.")).toBeNull();
  });
});

describe("keys sampler", () => {
  it("shows the strip with nothing chosen and keeps it when the track has no clip", async () => {
    await renderStudio(samplerSong("keys").song);
    const strip = within(dock()).getByRole("group", { name: "Sampler" });
    expect(within(strip).getByRole("button", { name: "Choose sample" })).toHaveTextContent("Choose sample…");
    expect(within(strip).getByRole("combobox", { name: "Root" })).toHaveValue("60");
    expect(within(strip).getByRole("switch", { name: "One-shot" })).toHaveAttribute("aria-checked", "false");
    expect(within(strip).getByRole("button", { name: "Clear sample" })).toHaveAttribute("aria-disabled", "true");
  });

  it("changes the root and one-shot as separate undo steps", async () => {
    await renderStudio(samplerSong("keys").song);
    const strip = within(dock()).getByRole("group", { name: "Sampler" });
    await userEvent.selectOptions(within(strip).getByRole("combobox", { name: "Root" }), "52");
    expect(statusText()).toBe("Root note E3.");
    await userEvent.click(within(strip).getByRole("switch", { name: "One-shot" }));
    expect(statusText()).toBe("One-shot on.");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(within(strip).getByRole("switch", { name: "One-shot" })).toHaveAttribute("aria-checked", "false");
    expect(within(strip).getByRole("combobox", { name: "Root" })).toHaveValue("52");
  });

  it("Choose a sample for keys", async () => {
    const vox = sample("vox", "vox-ah");
    await stock(vox);
    const { fake, access } = await (async () => {
      const f = createFakeMidi({ inputs: [{ id: "k", name: "KeyStep" }] });
      const a = createMidiAccess({ requestMIDIAccess: f.requestMIDIAccess, storage: null });
      await a.request();
      return { fake: f, access: a };
    })();
    await renderStudio(samplerSong("keys").song, { midi: access });

    await userEvent.click(screen.getByRole("button", { name: "Choose sample" }));
    const picker = await screen.findByRole("dialog", { name: "Choose sample for Sampler" });
    await userEvent.click(await within(picker).findByRole("button", { name: /^vox-ah, / }));
    expect(statusText()).toBe("Sampler plays vox-ah.");
    expect(await screen.findByRole("button", { name: "Sample vox-ah. Choose sample" })).toBeInTheDocument();

    // E4 is four semitones above the default C4 root.
    act(() => fake.send("k", [0x90, 64, 90], performance.now()));
    await waitFor(() => expect(heard.rates).toHaveLength(1));
    expect(heard.rates[0]).toBeCloseTo(2 ** (4 / 12));
    expect(liveNoteOn).toHaveBeenLastCalledWith(expect.objectContaining({ id: "E4" }), expect.objectContaining({ velocity: 90 }));
  });

  it("plays a different root's pitch after the root changes", async () => {
    const vox = sample("vox", "vox-ah");
    await stock(vox);
    const added = samplerSong("keys");
    const chosen = chooseKeysSample(added.song, added.trackId, vox).song!;
    const f = createFakeMidi({ inputs: [{ id: "k", name: "KeyStep" }] });
    const access = createMidiAccess({ requestMIDIAccess: f.requestMIDIAccess, storage: null });
    await access.request();
    await renderStudio(chosen, { midi: access });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Root" }), "64");
    act(() => f.send("k", [0x90, 64, 90], performance.now()));
    await waitFor(() => expect(heard.rates).toHaveLength(1));
    expect(heard.rates[0]).toBe(1);
  });

  it("clears the sample and returns focus to the chooser", async () => {
    const vox = sample("vox", "vox-ah");
    await stock(vox);
    const added = samplerSong("keys");
    await renderStudio(chooseKeysSample(added.song, added.trackId, vox).song!);
    await userEvent.click(screen.getByRole("button", { name: "Clear sample" }));
    expect(statusText()).toBe("Cleared vox-ah from Sampler.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose sample" })).toHaveFocus());
  });

  it("chooses a sample dropped on the strip from the library", async () => {
    const vox = sample("vox", "vox-ah");
    await stock(vox);
    await renderStudio(samplerSong("keys").song);
    const strip = within(dock()).getByRole("group", { name: "Sampler" });
    fireEvent.drop(strip, { dataTransfer: libraryDrag(vox.id) });
    expect(await screen.findByRole("button", { name: "Sample vox-ah. Choose sample" })).toBeInTheDocument();
  });

  it("says so when the sample's audio is not in this browser", async () => {
    const lost = sample("lost", "lost-vox");
    const added = samplerSong("keys");
    await renderStudio(chooseKeysSample(added.song, added.trackId, lost).song!);
    expect(await screen.findByRole("button", { name: "Sample lost-vox, audio missing. Choose sample" })).toBeInTheDocument();
    expect(screen.getByText(/The audio for lost-vox isn't in this browser/)).toBeInTheDocument();
  });
});

// Documents may omit the fields the server defaults, and the studio must open and play them like any other.
describe("sampler documents that omit their defaults", () => {
  const cases: { name: string; song: Song; error: string | null }[] = JSON.parse(
    readFileSync(resolve(__dirname, "../../../../fixtures/song_validation.json"), "utf8"),
  ).cases.filter((c: { name: string }) => /^(Keys|Pads) sampler with defaults omitted accepted$/.test(c.name));

  it("finds both cases", () => {
    expect(cases).toHaveLength(2);
  });

  it("opens a pads document and labels the pad", async () => {
    primeOverview("s1", new Float32Array([-0.5, 0.5]));
    await renderStudio(cases.find((c) => c.name.startsWith("Pads"))!.song);
    await userEvent.click(screen.getByRole("button", { name: /^Select Sampler track/ }));
    await userEvent.click(within(dock()).getByRole("button", { name: "New clip" }));
    const label = await screen.findByRole("button", { name: "Pad 2, Hit" });
    expect(label).not.toHaveAttribute("aria-description");
  });

  it("plays a keys document at the default root, not at NaN", async () => {
    primeOverview("s1", new Float32Array([-0.5, 0.5]));
    const f = createFakeMidi({ inputs: [{ id: "k", name: "KeyStep" }] });
    const access = createMidiAccess({ requestMIDIAccess: f.requestMIDIAccess, storage: null });
    await access.request();
    await renderStudio(cases.find((c) => c.name.startsWith("Keys"))!.song, { midi: access });
    await userEvent.click(screen.getByRole("button", { name: /^Select Sampler track/ }));
    expect(within(dock()).getByRole("combobox", { name: "Root" })).toHaveValue("60");
    expect(within(dock()).getByRole("switch", { name: "One-shot" })).toHaveAttribute("aria-checked", "false");
    act(() => f.send("k", [0x90, 72, 90], performance.now()));
    await waitFor(() => expect(heard.rates).toHaveLength(1));
    expect(heard.rates[0]).toBe(2);
  });
});
