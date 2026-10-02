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
import { createFakeProjectsApi } from "@/test/fakeProjectsApi";
import { createServerSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { normalizeSong } from "@/lib/song/songOps";
import { newSong, newTrack, type Song } from "@/lib/song/types";
import { drums } from "@/test/fixtures";
import { clearStoredValueCache } from "@/lib/useStoredValue";
import { SAMPLE_MIME } from "./samples/useSampleDrop";
import { StudioPage } from "./StudioPage";
import { act } from "@testing-library/react";
import { createInputManager } from "@/lib/audio/recorder/inputManager";
import { createInputOwner, type InputOwner } from "@/lib/audio/recorder/trackInput";
import { saveInputChoice } from "@/lib/audio/recorder/inputPrefs";
import { RECORD_MIC_BLOCKED } from "@/components/editor/useRecordControl";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
}));

const toggle = vi.fn();
const stopPlayback = vi.fn();
// One object for every render, as the real hook gives, because the recording session resets when the engine changes.
const fakeEngine = {
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
  prepareInput: vi.fn(async () => ({ sampleRate: 48000 })),
  setMonitoring: vi.fn(() => true),
};
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
    engine: fakeEngine,
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

// The take itself is covered by its own tests; here it only has to show that the page offers and drives one.
const takeTarget = vi.hoisted(() => ({
  begin: vi.fn(),
  add: vi.fn(),
  end: vi.fn(),
  discard: vi.fn(),
}));
const prepareTake = vi.hoisted(() => vi.fn());
vi.mock("@/lib/recording/audioTake", async (orig) => ({
  ...(await orig<typeof import("@/lib/recording/audioTake")>()),
  prepareAudioTake: prepareTake,
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

async function renderStudio(song: Song, inputs?: InputOwner) {
  await library.create(song);
  render(<StudioPage library={library} inputs={inputs} />);
  await screen.findByRole("region", { name: "Arrangement" });
}

const audioTrackId = () => document.querySelector<HTMLElement>("[data-track-lane]")!.dataset.trackLane!;
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
  await clear(createStore("songbird-sample-library.test-user", "library"));
  library = createServerSongLibrary(createFakeProjectsApi().api);
  toggle.mockClear();
  stopPlayback.mockClear();
  previewToggle.mockClear();
  previewListeners.clear();
  importFiles.mockReset();
  prepareTake.mockReset();
  Object.values(takeTarget).forEach((fn) => fn.mockReset());
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

// A browser with the given inputs and permission, and a tap the test can push peaks through.
function fakeInputs(opts: { permission?: "prompt" | "granted" | "denied"; devices?: string[]; reject?: string } = {}) {
  const devices = (opts.devices ?? ["Built-in Microphone", "Scarlett 2i2"]).map((label, i) => ({
    kind: "audioinput",
    deviceId: `dev${i}`,
    label,
  }));
  const peakListeners = new Set<(p: { frame: number; peak: number }) => void>();
  const tap = {
    startCapture: vi.fn(),
    stopCapture: async () => {},
    subscribePeaks: (cb: (p: { frame: number; peak: number }) => void) => {
      peakListeners.add(cb);
      return () => peakListeners.delete(cb);
    },
    clipHeld: () => false,
    clearClip: vi.fn(),
    dispose: vi.fn(),
  };
  const track = { getSettings: () => ({ channelCount: 2 }), stop: vi.fn() };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const getUserMedia = vi.fn(async () => {
    if (opts.reject) throw Object.assign(new Error("no"), { name: opts.reject });
    return stream;
  });
  const manager = createInputManager({
    mediaDevices: { enumerateDevices: async () => devices, getUserMedia },
    queryPermission: async () => opts.permission ?? "prompt",
  });
  const owner = createInputOwner(manager, { createTap: async () => tap as never, nativeContext: () => ({ createMediaStreamSource: () => ({}) }) as never });
  fakeEngine.prepareInput.mockResolvedValue({
    sampleRate: 48000,
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
  } as never);
  return { owner, getUserMedia, peak: (peak: number) => act(() => peakListeners.forEach((cb) => cb({ frame: 0, peak }))) };
}

describe("audio track recording controls", () => {
  const trigger = () => screen.findByRole("button", { name: /^Input for Loops/ });

  it("Choose an interface input: the choice is kept for the track and survives a remount", async () => {
    const { owner, getUserMedia } = fakeInputs({ permission: "granted" });
    await renderStudio(audioSong([], []), owner);
    await userEvent.click(await trigger());
    const dialog = await screen.findByRole("dialog", { name: "Input for Loops" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "Scarlett 2i2" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "Mono" }));
    expect(await screen.findByRole("button", { name: "Input for Loops: Scarlett 2i2, mono" })).toBeInTheDocument();
    await waitFor(() =>
      expect(getUserMedia).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: "dev1", channelCount: 1 }) }),
    );

    cleanup();
    const again = fakeInputs({ permission: "granted" });
    render(<StudioPage library={library} inputs={again.owner} />);
    expect(await screen.findByRole("button", { name: "Input for Loops: Scarlett 2i2, mono" })).toBeInTheDocument();
  });

  it("says the default is in use when the remembered input is not connected", async () => {
    const { owner } = fakeInputs({ permission: "granted", devices: ["Built-in Microphone"] });
    const song = audioSong([], []);
    saveInputChoice(song.tracks[0].id, { deviceId: "gone", channels: 1, label: "Scarlett 2i2" });
    await renderStudio(song, owner);
    expect(
      await screen.findByRole("button", { name: "Input for Loops: default input (Scarlett 2i2 not connected)" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Input for Loops/ }));
    const dialog = await screen.findByRole("dialog", { name: "Input for Loops" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Scarlett 2i2 isn't connected, so Loops is using the default input.");
  });

  it("Permission denied: the how-to-allow help shows and Record is disabled with the reason", async () => {
    const { owner } = fakeInputs({ reject: "NotAllowedError" });
    await renderStudio(audioSong([], []), owner);
    expect(await trigger()).toHaveAccessibleName("Input for Loops: allow microphone");

    // Opening the popover is what asks, and the browser answers no.
    await userEvent.click(await trigger());
    expect(await screen.findByRole("button", { name: "Input for Loops: microphone blocked" })).toBeInTheDocument();
    const dialog = await screen.findByRole("dialog", { name: "Input for Loops" });
    expect(within(dialog).getByText(/Microphone access is blocked for this site/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Try again" })).toBeInTheDocument();

    const record = screen.getByRole("button", { name: "Record" });
    expect(record).toHaveAttribute("aria-disabled", "true");
    expect(record).toHaveAccessibleDescription(RECORD_MIC_BLOCKED);
  });

  it("opens the track's input popover when Record is pressed with the microphone blocked", async () => {
    const { owner } = fakeInputs({ permission: "denied" });
    await renderStudio(audioSong([], []), owner);
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-disabled", "true"));
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(await screen.findByRole("dialog", { name: "Input for Loops" })).toBeInTheDocument();
    expect(statusText()).toBe(RECORD_MIC_BLOCKED);
  });

  it("Clipping shown: lights on full scale, stays lit through quiet peaks, and clears when clicked", async () => {
    const { owner, peak } = fakeInputs({ permission: "granted" });
    await renderStudio(audioSong([], []), owner);
    const clip = await screen.findByRole("button", { name: "Clear clip indicator for Loops" });
    expect(clip).toHaveAttribute("aria-disabled", "true");
    // The meter opens the input for the selected track, so wait for it to be listening.
    await waitFor(() => expect(owner.tap(audioTrackId())).not.toBeNull());

    peak(1);
    await waitFor(() => expect(clip).toHaveAttribute("data-clipped", "true"));
    expect(clip).not.toHaveAttribute("aria-disabled", "true");
    expect(statusText()).toMatch(/^Loops input clipped/);

    peak(0.1);
    peak(0.05);
    expect(clip).toHaveAttribute("data-clipped", "true");

    await userEvent.click(clip);
    expect(clip).toHaveAttribute("aria-disabled", "true");
    expect(clip).not.toHaveAttribute("data-clipped");
  });

  it("Monitor asks for headphones first, stores that only on confirm, and routes the input through the track", async () => {
    const { owner } = fakeInputs({ permission: "granted" });
    await renderStudio(audioSong([], []), owner);
    const monitor = await screen.findByRole("button", { name: "Monitor Loops" });

    await userEvent.click(monitor);
    const warning = await screen.findByRole("alertdialog", { name: "Wear headphones to monitor" });
    await userEvent.click(within(warning).getByRole("button", { name: "Cancel" }));
    expect(monitor).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem("songbird.monitorWarned.v1")).toBeNull();
    expect(fakeEngine.setMonitoring).not.toHaveBeenCalledWith(expect.anything(), true, expect.anything());

    await userEvent.click(monitor);
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Turn on Monitor" }));
    expect(monitor).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("songbird.monitorWarned.v1")).toBe("true");
    await waitFor(() => expect(fakeEngine.setMonitoring).toHaveBeenCalledWith(audioTrackId(), true, expect.anything()));

    await userEvent.click(monitor);
    expect(monitor).toHaveAttribute("aria-pressed", "false");
    expect(fakeEngine.setMonitoring).toHaveBeenLastCalledWith(audioTrackId(), false);
  });
});

describe("recording on an audio track", () => {
  // jsdom has no capture API, which the page rightly treats as an unsupported browser.
  beforeEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("Record on an audio track without MIDI: Record is enabled and records audio", async () => {
    prepareTake.mockResolvedValue({ target: takeTarget });
    takeTarget.end.mockReturnValue({
      recorded: 0,
      dropped: {},
      settled: Promise.resolve({ kind: "saved", trackName: "Loops", takeName: "Loops Take 1", takes: 1, measures: 2 }),
    });
    await renderStudio(audioSong([], []));
    const record = screen.getByRole("button", { name: "Record" });
    expect(record).not.toHaveAttribute("aria-disabled");

    await userEvent.click(record);
    await waitFor(() => expect(takeTarget.begin).toHaveBeenCalled());
    expect(prepareTake).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(String), expect.anything(), expect.anything());
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "true"));

    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(statusText()).toBe("Recorded Loops Take 1, 2 bars. Undo removes the take."));
  });

  it("shows a failed save as an error under the transport, not only in the status line", async () => {
    prepareTake.mockResolvedValue({ target: takeTarget });
    takeTarget.end.mockReturnValue({ recorded: 0, dropped: {}, settled: Promise.resolve({ kind: "failed", reason: "storage" }) });
    await renderStudio(audioSong([], []));
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(screen.getByRole("button", { name: "Record" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Couldn't save the recording because browser storage is full. Nothing was added. Remove unused samples or takes, then try again.",
    );
    await userEvent.click(within(alert).getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("discards a take that finishes preparing after the page is gone, rather than starting it", async () => {
    let ready!: (value: unknown) => void;
    prepareTake.mockReturnValue(new Promise((resolve) => (ready = resolve)));
    await renderStudio(audioSong([], []));
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(prepareTake).toHaveBeenCalled());
    cleanup();
    ready({ target: takeTarget });
    // The target already holds the microphone, which only discarding gives back.
    await waitFor(() => expect(takeTarget.discard).toHaveBeenCalled());
    expect(takeTarget.begin).not.toHaveBeenCalled();
  });

  it("says why when the microphone is unavailable, and records nothing", async () => {
    prepareTake.mockResolvedValue({ reason: "no-input" });
    await renderStudio(audioSong([], []));
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() =>
      expect(statusText()).toBe("No audio input found. Connect a microphone or interface to record."),
    );
    expect(takeTarget.begin).not.toHaveBeenCalled();
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

describe("takes", () => {
  // Three takes on Vocals, and one clip over measure 1 that plays the third.
  function takesSong(): Song {
    const track = newTrack("audio", "Vocals");
    const take = (n: number): Sample => ({
      ...sample(`t${n}`, `Vocals Take ${n}`),
      origin: "recording",
      track_id: track.id,
      recorded_at_ticks: 0,
    });
    const takes = [take(1), take(2), take(3)];
    for (const t of takes) primeOverview(t.id, Float32Array.from({ length: 64 }, (_, i) => (i % 2 ? 0.6 : -0.6)));
    return normalizeSong({
      ...newSong("4/4", 120),
      samples: takes,
      tracks: [{ ...track, audio_clips: [clipAt("c1", takes[2], 1)] }],
    });
  }
  const dock = () => screen.getByRole("region", { name: /^Editor:/ });
  async function openPanel() {
    await renderStudio(takesSong());
    await userEvent.click(clipButton(/^Vocals Take 3/));
    return within(dock());
  }

  it("Switch to an earlier take: the clip keeps its place, and one undo brings the third back", async () => {
    const panel = await openPanel();
    expect(panel.getByRole("button", { name: "Use Vocals Take 3" })).toHaveAttribute("aria-current", "true");
    await userEvent.click(panel.getByRole("button", { name: "Use Vocals Take 2" }));

    expect(clipButton(/^Vocals Take 2, measure 1 beat 1/)).toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Use Vocals Take 2" })).toHaveAttribute("aria-current", "true");
    expect(statusText()).toBe("Clip now plays Vocals Take 2.");

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(clipButton(/^Vocals Take 3, measure 1 beat 1/)).toBeInTheDocument();
  });

  it("works with a take id that is not safe in a selector", async () => {
    const song = takesSong();
    const odd = song.samples!.map((t, i) => ({ ...t, id: [`q"]`, `a'b`, `t3`][i] }));
    const clip = { ...song.tracks[0].audio_clips![0], sample_id: "t3" };
    await renderStudio({ ...song, samples: odd, tracks: [{ ...song.tracks[0], audio_clips: [clip] }] });
    await userEvent.click(clipButton(/^Vocals Take 3/));
    const panel = within(dock());
    await userEvent.click(panel.getByRole("button", { name: "Take actions for Vocals Take 1" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete take" }));
    expect(panel.queryByRole("button", { name: "Use Vocals Take 1" })).not.toBeInTheDocument();
    // Deleting hands focus to the neighbouring row on the next frame.
    await waitFor(() => expect(panel.getByRole("button", { name: "Use Vocals Take 2" })).toHaveFocus());
    await userEvent.keyboard("{ArrowUp}");
    expect(panel.getByRole("button", { name: "Use Vocals Take 3" })).toHaveFocus();
  });

  it("lists newest first and marks what is current and unused", async () => {
    const panel = await openPanel();
    const rows = within(panel.getByRole("list", { name: "Takes on Vocals" })).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("button", { name: /^Use / }).getAttribute("aria-label"))).toEqual([
      "Use Vocals Take 3",
      "Use Vocals Take 2",
      "Use Vocals Take 1",
    ]);
    expect(within(rows[0]).getByText("Current")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Unused")).toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Delete unused (2)" })).toBeInTheDocument();
  });

  it("Delete an unused take: it leaves the song, and a take in use cannot be deleted", async () => {
    const panel = await openPanel();
    await userEvent.click(panel.getByRole("button", { name: "Take actions for Vocals Take 3" }));
    const inUse = screen.getByRole("menuitem", { name: "Delete take" });
    expect(inUse).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Used by 1 clip")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(panel.getByRole("button", { name: "Take actions for Vocals Take 1" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete take" }));
    expect(panel.queryByRole("button", { name: "Use Vocals Take 1" })).not.toBeInTheDocument();
    expect(statusText()).toBe("Deleted Vocals Take 1. Undo restores it.");

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(within(dock()).getByRole("button", { name: "Use Vocals Take 1" })).toBeInTheDocument();
  });

  it("deletes every unused take as one undo step", async () => {
    const panel = await openPanel();
    await userEvent.click(panel.getByRole("button", { name: "Delete unused (2)" }));
    expect(within(dock()).getAllByRole("button", { name: /^Use / })).toHaveLength(1);
    expect(statusText()).toBe("Deleted 2 unused takes. Undo restores them.");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(within(dock()).getAllByRole("button", { name: /^Use / })).toHaveLength(3);
  });

  it("renames a take in place", async () => {
    const panel = await openPanel();
    await userEvent.click(panel.getByRole("button", { name: "Take actions for Vocals Take 2" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const field = panel.getByRole("textbox", { name: "Take name Vocals Take 2" });
    await userEvent.clear(field);
    await userEvent.type(field, "Best chorus{Enter}");
    expect(panel.getByRole("button", { name: "Use Best chorus" })).toBeInTheDocument();
  });

  it("Add a take to the library: it shows as in library and the Samples panel lists it", async () => {
    const panel = await openPanel();
    await userEvent.click(panel.getByRole("button", { name: "Take actions for Vocals Take 2" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Add to library" }));
    await waitFor(() => expect(statusText()).toBe("Added Vocals Take 2 to Samples."));
    // The library list refreshes after the add, so the badge arrives a moment after the announcement.
    await waitFor(() => expect(panel.getAllByText("In library")).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "Samples" }));
    const samples = await screen.findByRole("dialog", { name: "Samples" });
    expect(await within(samples).findByText("Vocals Take 2")).toBeInTheDocument();
  });

  it("offers the track's takes from the clip menu as a drill-in", async () => {
    await renderStudio(takesSong());
    fireEvent.contextMenu(clipButton(/^Vocals Take 3/));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^Takes \(3\)/ }));
    expect(screen.getByRole("menuitem", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /^Vocals Take 3/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitem", { name: "Delete unused takes (2)" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "All takes…" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Vocals Take 2/ }));
    expect(clipButton(/^Vocals Take 2, measure 1 beat 1/)).toBeInTheDocument();
  });

  it("hides Takes for a track with no takes, and lists none in the panel", async () => {
    const s = sample("a", "kick-808");
    await renderStudio(audioSong([s], [clipAt("c1", s, 1)]));
    fireEvent.contextMenu(clipButton(/^kick-808/));
    expect(await screen.findByRole("menuitem", { name: "Replace sample…" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Takes/ })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(clipButton(/^kick-808/));
    expect(within(dock()).getByText("No takes on Loops yet. Select the track and press Record.")).toBeInTheDocument();
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
