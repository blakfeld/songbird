import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clear, createStore } from "idb-keyval";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioClip } from "@/generated/AudioClip";
import type { Sample } from "@/generated/Sample";
import * as api from "@/lib/api";
import { addToLibrary } from "@/lib/audio/sampleLibrary";
import { primeOverview } from "@/lib/audio/useSampleLibrary";
import { createSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { normalizeSong } from "@/lib/song/songOps";
import { newSong, newTrack, type Song } from "@/lib/song/types";
import { drums } from "@/test/fixtures";
import { clearStoredValueCache } from "@/lib/useStoredValue";
import { SAMPLE_MIME } from "./samples/useSampleDrop";
import { StudioPage } from "./StudioPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
}));

const toggle = vi.fn();
const stopPlayback = vi.fn();
vi.mock("@/lib/audio/useSongPlayback", () => ({
  useSongPlayback: () => ({
    isPlaying: true,
    status: "ready",
    error: null,
    toggle,
    stop: stopPlayback,
    seek: vi.fn(),
    preload: vi.fn(),
    subscribePosition: () => () => {},
    audition: vi.fn(async () => {}),
    engine: {
      prepareLive: vi.fn(async () => {}),
      liveNoteOn: vi.fn(() => ({})),
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
  }),
}));

const previewToggle = vi.fn(async () => {});
const previewListeners = new Set<(id: string | null) => void>();
vi.mock("@/lib/audio/samplePreview", () => ({
  getSamplePreview: () => ({
    toggle: previewToggle,
    stop: vi.fn(),
    current: () => null,
    subscribe: (cb: (id: string | null) => void) => {
      previewListeners.add(cb);
      return () => previewListeners.delete(cb);
    },
  }),
}));

const importFiles = vi.fn();
vi.mock("@/lib/audio/sampleImport", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio/sampleImport")>()),
  importAudioFiles: (...args: unknown[]) => importFiles(...args),
}));

// At 120 BPM and 48 kHz one 4/4 measure is 2 s: 96000 frames and 3840 ticks.
const FRAMES = 96000;
const sample = (id: string, name: string, measures = 1): Sample => ({
  id,
  name,
  sample_rate: 48000,
  channels: 2,
  length_samples: FRAMES * measures,
  origin: "import",
});
const clipAt = (id: string, s: Sample, measure: number, extra: Partial<AudioClip> = {}): AudioClip => ({
  id,
  sample_id: s.id,
  start_ticks: (measure - 1) * 3840,
  offset_samples: 0,
  slice_samples: s.length_samples,
  length_samples: s.length_samples,
  loop: false,
  gain_db: 0,
  fade_in_samples: 0,
  fade_out_samples: 0,
  ...extra,
});

function audioSong(samples: Sample[], clips: AudioClip[]): Song {
  const song = newSong("4/4", 120);
  for (const s of samples) primeOverview(s.id, Float32Array.from({ length: 64 }, (_, i) => (i % 2 ? 0.6 : -0.6)));
  return normalizeSong({
    ...song,
    samples,
    tracks: [{ ...newTrack("audio", "Loops"), audio_clips: clips }],
  });
}

const LANE_PX = 1600;
const MEASURE_PX = 100;
const px = (measure: number) => (measure - 1) * MEASURE_PX + MEASURE_PX / 2;

function stubLaneRects() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const wide = this.dataset.testid === "clip-lane" || this.dataset.testid === "new-track-drop-lane";
    return { x: 0, y: 0, left: 0, top: 0, right: wide ? LANE_PX : 0, bottom: 0, width: wide ? LANE_PX : 0, height: 0, toJSON: () => ({}) } as DOMRect;
  });
}

let library: SongLibrary;

async function renderStudio(song: Song) {
  await library.create(song);
  render(<StudioPage library={library} />);
  await screen.findByRole("region", { name: "Arrangement" });
}

const clipButton = (name: string | RegExp) => screen.getByRole("button", { name });
const laneEl = () => screen.getByTestId("clip-lane");
const statusText = () => document.querySelector<HTMLElement>("p[role=status].min-h-5")!.textContent;

const drag = (el: Element, from: number, to: number, init: object = {}) => {
  fireEvent.pointerDown(el, { clientX: from, button: 0, pointerId: 1, ...init });
  fireEvent.pointerMove(el, { clientX: to, pointerId: 1, ...init });
  fireEvent.pointerUp(el, { clientX: to, pointerId: 1, ...init });
};

const dataTransfer = (init: { types: string[]; data?: Record<string, string>; files?: File[] }) => ({
  types: init.types,
  getData: (type: string) => init.data?.[type] ?? "",
  files: init.files ?? [],
  dropEffect: "none",
  effectAllowed: "all",
  setData: vi.fn(),
});

// jsdom has no DragEvent, and a plain Event would drop the pointer position the lanes read.
beforeAll(() => {
  if (!("DragEvent" in window)) Object.defineProperty(window, "DragEvent", { value: class DragEvent extends MouseEvent {}, configurable: true });
});

beforeEach(async () => {
  localStorage.clear();
  clearStoredValueCache();
  await clear();
  await clear(createStore("songbird-sample-library", "library"));
  library = createSongLibrary();
  toggle.mockClear();
  stopPlayback.mockClear();
  previewToggle.mockClear();
  previewListeners.clear();
  importFiles.mockReset();
  vi.mocked(api.getInstruments).mockResolvedValue([drums]);
  stubLaneRects();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const entry = (s: Sample, importedAt = 1) => ({
  id: s.id,
  name: s.name,
  sampleRate: s.sample_rate,
  channels: s.channels,
  length: s.length_samples,
  importedAt,
});

describe("audio tracks", () => {
  it("Add an audio track", async () => {
    await renderStudio(normalizeSong(newSong("4/4", 120)));
    await userEvent.click(screen.getByRole("button", { name: "Add track" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Audio" }));
    expect(screen.getByRole("button", { name: "Select Audio track (Audio)" })).toBeInTheDocument();
    expect(screen.getByText(/Drop audio here or drag from Samples/)).toBeInTheDocument();
    expect(statusText()).toBe("Added an audio track.");
  });

  it("Waveform follows gain", async () => {
    const s = sample("a", "kick-808");
    await renderStudio(audioSong([s], [clipAt("c1", s, 1)]));
    const block = clipButton(/^kick-808, measure 1 beat 1/);
    expect(within(block).getByTestId("clip-wave")).toHaveAttribute("data-gain-scale", "1.000");
    block.focus();
    for (let i = 0; i < 6; i++) await userEvent.keyboard("{ArrowUp}");
    const raised = clipButton(/^kick-808.*gain 6 dB/);
    expect(Number(within(raised).getByTestId("clip-wave").getAttribute("data-gain-scale"))).toBeCloseTo(1.995, 2);
  });

  it("Trim the start", async () => {
    const s = sample("a", "breakbeat", 4);
    await renderStudio(audioSong([s], [clipAt("c1", s, 3)]));
    const block = clipButton(/^breakbeat, measure 3 beat 1/);
    drag(block.querySelector('[data-handle="trim-start"]')!, 0, MEASURE_PX);
    expect(clipButton(/^breakbeat, measure 4 beat 1 to measure 6 beat 4/)).toBeInTheDocument();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(clipButton(/^breakbeat, measure 3 beat 1 to measure 6 beat 4/)).toBeInTheDocument();
  });

  it("Extend a loop", async () => {
    const s = sample("a", "loop", 2);
    await renderStudio(audioSong([s], [clipAt("c1", s, 1, { loop: true })]));
    const block = clipButton(/^loop, measure 1 beat 1 to measure 2 beat 4, looping/);
    drag(block.querySelector('[data-handle="trim-end"]')!, 0, 6 * MEASURE_PX);
    const longer = clipButton(/^loop, measure 1 beat 1 to measure 8 beat 4, looping/);
    expect(within(longer).getAllByTestId("repeat-mark")).toHaveLength(3);
  });

  it("Move stops at a neighbour", async () => {
    const s = sample("a", "kick");
    const t = sample("b", "snare");
    await renderStudio(audioSong([s, t], [clipAt("c1", s, 1), clipAt("c2", t, 5)]));
    drag(clipButton(/^kick, measure 1/), px(1), px(9));
    expect(clipButton(/^kick, measure 4 beat 1 to measure 4 beat 4/)).toBeInTheDocument();
    expect(clipButton(/^snare, measure 5 beat 1/)).toBeInTheDocument();
  });

  it("Undo a fade", async () => {
    const s = sample("a", "pad", 2);
    await renderStudio(audioSong([s], [clipAt("c1", s, 1)]));
    const block = clipButton(/^pad/);
    const points = () => within(clipButton(/^pad/)).getByTestId("clip-envelope").getAttribute("points")!;
    expect(points().startsWith("0,1 0,")).toBe(true);
    drag(block.querySelector('[data-handle="fade-in"]')!, 0, 50);
    expect(points().startsWith("0,1 0,")).toBe(false);
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(points().startsWith("0,1 0,")).toBe(true);
  });
});

describe("audio clip panel", () => {
  it("Edit gain from the panel", async () => {
    const s = sample("a", "kick-808");
    await renderStudio(audioSong([s], [clipAt("c1", s, 1)]));
    await userEvent.click(clipButton(/^kick-808/));
    const dock = screen.getByRole("region", { name: "Editor: kick-808 on Loops" });
    const gain = within(dock).getByRole("slider", { name: "Gain" });
    gain.focus();
    // Held keys share one gesture, which is what makes this a single undo step.
    for (let i = 0; i < 12; i++) fireEvent.keyDown(gain, { key: "ArrowDown" });
    fireEvent.keyUp(gain, { key: "ArrowDown" });
    const quieter = clipButton(/^kick-808.*gain −6 dB/);
    expect(Number(within(quieter).getByTestId("clip-wave").getAttribute("data-gain-scale"))).toBeCloseTo(0.501, 2);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(clipButton(/^kick-808, measure 1 beat 1 to measure 1 beat 4$/)).toBeInTheDocument();
  });

  it("No generate menu item", async () => {
    const s = sample("a", "kick-808");
    await renderStudio(audioSong([s], [clipAt("c1", s, 1)]));
    await userEvent.click(screen.getByRole("button", { name: /^Track options for Loops/ }));
    expect(screen.getByRole("menuitem", { name: "Import audio…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sound…" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Generate part with AI/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /New clip/ })).not.toBeInTheDocument();
  });
});

describe("samples panel", () => {
  const openPanel = async () => {
    await userEvent.click(screen.getByRole("button", { name: "Samples" }));
    return screen.findByRole("dialog", { name: "Samples" });
  };

  it("Search", async () => {
    await addToLibrary(entry(sample("1", "kick-808"), 1));
    await addToLibrary(entry(sample("2", "Kick Acoustic"), 2));
    await addToLibrary(entry(sample("3", "snare"), 3));
    await renderStudio(audioSong([], []));
    const panel = await openPanel();
    const list = await within(panel).findByRole("list", { name: "Samples" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    await userEvent.type(within(panel).getByRole("searchbox", { name: "Search samples" }), "kick");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(list).queryByText("snare")).not.toBeInTheDocument();
  });

  it("Preview while playing", async () => {
    await addToLibrary(entry(sample("3", "snare"), 3));
    await renderStudio(audioSong([], []));
    await openPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Preview snare" }));
    expect(previewToggle).toHaveBeenCalledWith("3");
    previewListeners.forEach((l) => l("3"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview snare" })).toHaveAttribute("aria-pressed", "true"));
    expect(toggle).not.toHaveBeenCalled();
    expect(stopPlayback).not.toHaveBeenCalled();
  });

  it("Remove a sample used by a song", async () => {
    const s = sample("1", "breakbeat-120");
    await addToLibrary(entry(s));
    await renderStudio(audioSong([s], [clipAt("c1", s, 1)]));
    await openPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Sample actions for breakbeat-120" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from library…" }));
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(within(dialog).getByText(/still uses it/)).toBeInTheDocument());
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Samples" })).not.toBeInTheDocument());
    expect(clipButton(/^breakbeat-120/)).toBeInTheDocument();
  });

  it("Drag a sample to a lane", async () => {
    const s = sample("1", "breakbeat-120");
    await addToLibrary(entry(s));
    await renderStudio(audioSong([], []));
    primeOverview(s.id, new Float32Array([-0.5, 0.5]));
    await openPanel();
    const row = await screen.findByRole("button", { name: /^breakbeat-120, 2\.0 seconds/ });
    const dt = dataTransfer({ types: [SAMPLE_MIME], data: { [SAMPLE_MIME]: s.id } });
    fireEvent.dragStart(row, { dataTransfer: dt });
    fireEvent.drop(laneEl(), { dataTransfer: dt, clientX: 4 * MEASURE_PX });
    await waitFor(() => expect(clipButton(/^breakbeat-120, measure 5 beat 1/)).toBeInTheDocument());
    expect(statusText()).toMatch(/^Placed breakbeat-120 on Loops at 5\.1\.1\./);
  });

  it("Drop a file below the lanes", async () => {
    const s = sample("v", "vocal-chop");
    primeOverview(s.id, new Float32Array([-0.5, 0.5]));
    importFiles.mockResolvedValue({
      lowStorage: false,
      outcomes: [{ ok: true, file: "vocal-chop.wav", entry: entry(s), duplicate: false }],
    });
    await renderStudio(audioSong([], []));
    const file = new File(["x"], "vocal-chop.wav", { type: "audio/wav" });
    fireEvent.dragEnter(window, { dataTransfer: dataTransfer({ types: ["Files"] }) });
    const zone = await screen.findByTestId("new-track-drop");
    fireEvent.drop(zone, {
      dataTransfer: dataTransfer({ types: ["Files"], files: [file] }),
      clientX: 8 * MEASURE_PX,
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Select vocal-chop track/ })).toBeInTheDocument());
    expect(clipButton(/^vocal-chop, measure 9 beat 1/)).toBeInTheDocument();
  });

  it("Keyboard placement", async () => {
    const s = sample("1", "kick");
    await addToLibrary(entry(s));
    await renderStudio(audioSong([], []));
    primeOverview(s.id, new Float32Array([-0.5, 0.5]));
    fireEvent.click(laneEl(), { clientX: px(3) });
    await openPanel();
    const row = await screen.findByRole("button", { name: /^kick, 2\.0 seconds/ });
    row.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(clipButton(/^kick, measure 3 beat 1/)).toBeInTheDocument());
  });

  it("Overlap refused", async () => {
    const taken = sample("t", "snare");
    const s = sample("1", "kick");
    await addToLibrary(entry(s));
    await renderStudio(audioSong([taken], [clipAt("c1", taken, 5)]));
    await openPanel();
    const row = await screen.findByRole("button", { name: /^kick, 2\.0 seconds/ });
    const dt = dataTransfer({ types: [SAMPLE_MIME], data: { [SAMPLE_MIME]: s.id } });
    fireEvent.dragStart(row, { dataTransfer: dt });
    fireEvent.drop(laneEl(), { dataTransfer: dt, clientX: 4 * MEASURE_PX });
    await waitFor(() => expect(statusText()).toMatch(/^Couldn't place kick: the space at 5\.1\.1 on Loops is taken\./));
    expect(screen.queryByRole("button", { name: /^kick, measure/ })).not.toBeInTheDocument();
  });
});

describe("refusals and keyboard", () => {
  it("shows a refused tempo change on the status line", async () => {
    const s = sample("a", "long", 2);
    await renderStudio(audioSong([s], [clipAt("c1", s, 126)]));
    const tempo = screen.getByRole("spinbutton", { name: "Tempo" });
    await userEvent.clear(tempo);
    await userEvent.type(tempo, "240{Enter}");
    expect(statusText()).toMatch(/^Tempo not changed: at 240 BPM an audio clip would run past measure 128/);
    expect(screen.getByRole("spinbutton", { name: "Tempo" })).toHaveValue(120);
  });

  it("replaces a clip's sample from the dialog, keeping its place", async () => {
    const kick = sample("1", "kick");
    const snare = sample("2", "snare");
    await addToLibrary(entry(kick, 1));
    await addToLibrary(entry(snare, 2));
    primeOverview(snare.id, new Float32Array([-0.5, 0.5]));
    await renderStudio(audioSong([kick], [clipAt("c1", kick, 3)]));
    await userEvent.click(clipButton(/^kick/));
    const dock = screen.getByRole("region", { name: "Editor: kick on Loops" });
    await userEvent.click(within(dock).getByRole("button", { name: "Replace sample…" }));
    const dialog = await screen.findByRole("dialog", { name: "Replace sample" });
    const current = await within(dialog).findByRole("button", { name: /^kick, 2\.0 seconds/ });
    expect(current).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(dialog).getByRole("button", { name: /^snare, 2\.0 seconds/ }));
    await waitFor(() => expect(clipButton(/^snare, measure 3 beat 1/)).toBeInTheDocument());
    expect(statusText()).toBe("Replaced kick with snare.");
  });

  it("walks the sample list with the arrow keys", async () => {
    await addToLibrary(entry(sample("1", "alpha"), 1));
    await addToLibrary(entry(sample("2", "bravo"), 2));
    await addToLibrary(entry(sample("3", "charlie"), 3));
    await renderStudio(audioSong([], []));
    await userEvent.click(screen.getByRole("button", { name: "Samples" }));
    const first = await screen.findByRole("button", { name: /^charlie, / });
    first.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^bravo, / }));
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sample actions for bravo" }));
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preview bravo" }));
    await userEvent.keyboard("{ArrowRight}{End}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^alpha, / }));
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(first);
  });
});
