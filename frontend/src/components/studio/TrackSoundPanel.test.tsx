import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import { createSongStore, useSongStore } from "@/lib/song/songStore";
import { newSong } from "@/lib/song/types";
import { drums } from "@/test/fixtures";
import type { ClipActions } from "./useClipActions";
import { TrackHeader } from "./TrackHeader";
import type { TrackActions } from "./trackActions";

afterEach(cleanup);

const bass: InstrumentInfo = {
  id: "bass",
  name: "Bass",
  kind: "melodic",
  midi_program: 33,
  range: { low: 28, high: 52 },
  midi_channel: 2,
  sustained: true,
  rows: [],
};
const infos: Record<string, InstrumentInfo> = { drums, bass };

function setup(sound?: object) {
  const base = newSong();
  const song = {
    ...base,
    tracks: [base.tracks[0], { ...base.tracks[1], instrument: "bass", name: "Bass", ...(sound && { sound }) }],
  };
  const store = createSongStore(song as never);
  const actions: TrackActions = {
    select: () => {},
    rename: () => {},
    remove: () => {},
    mixer: () => {},
    generate: () => {},
    sound: (id, patch, o) => store.getState().setSound(id, patch, o),
    resetSound: (id) => store.getState().resetSound(id),
    beginGesture: () => store.getState().beginGesture(),
    endGesture: () => store.getState().endGesture(),
  };
  function Harness() {
    const s = useSongStore(store, (st) => st.song)!;
    const [open, setOpen] = useState<string | null>(null);
    return (
      <>
        {s.tracks.map((t, i) => (
          <TrackHeader
            key={t.id}
            song={s}
            track={t}
            number={i + 1}
            selected={false}
            canDelete
            instrument={{ state: "ready", info: infos[t.instrument] }}
            actions={actions}
            soundOpen={open === t.id}
            onSoundOpen={(o) => setOpen(o ? t.id : null)}
            selectedClipId={null}
            clipActions={new Proxy({}, { get: () => vi.fn() }) as ClipActions}
            generating={false}
            generateBlocked={false}
          />
        ))}
      </>
    );
  }
  render(<Harness />);
  const bassSound = () => store.getState().song!.tracks[1].sound;
  return { store, bassSound };
}

const openBass = async () => {
  await userEvent.click(screen.getByRole("button", { name: /^Sound for Bass/ }));
  const panel = await screen.findByRole("dialog", { name: "Bass sound" });
  // Focus lands a frame after opening; keys sent earlier would go to the wrong element.
  await waitFor(() => expect(panel).toHaveFocus());
  return panel;
};

describe("Sound panel", () => {
  it("opens for the Bass track with its tone knobs and five effects, all off", async () => {
    setup();
    const panel = await openBass();
    expect(panel).toHaveAttribute("aria-modal", "false");
    for (const name of ["Filter cutoff", "Filter resonance", "Attack", "Decay", "Sustain", "Release"])
      expect(within(panel).getByRole("slider", { name })).toBeInTheDocument();
    expect(within(panel).queryByRole("slider", { name: "Pitch" })).toBeNull();
    for (const name of ["EQ", "Distortion", "Chorus", "Delay", "Reverb"])
      expect(within(panel).getByRole("switch", { name })).toHaveAttribute("aria-checked", "false");
  });

  it("shows pitch and no envelope knobs for drums", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /^Sound for Drums/ }));
    const panel = await screen.findByRole("dialog", { name: "Drums sound" });
    expect(within(panel).getByRole("slider", { name: "Pitch" })).toBeInTheDocument();
    expect(within(panel).getByRole("slider", { name: "Filter cutoff" })).toBeInTheDocument();
    expect(within(panel).queryByRole("slider", { name: "Attack" })).toBeNull();
  });

  it("shows drum knobs for a drums track while the instrument lookup is unavailable", async () => {
    const base = newSong();
    const store = createSongStore(base);
    const actions = { sound: () => {} } as unknown as TrackActions;
    render(
      <TrackHeader
        song={base}
        track={store.getState().song!.tracks[0]}
        number={1}
        selected={false}
        canDelete
        instrument={{ state: "missing" }}
        actions={actions}
        soundOpen
        onSoundOpen={() => {}}
        selectedClipId={null}
        clipActions={new Proxy({}, { get: () => vi.fn() }) as ClipActions}
        generating={false}
        generateBlocked={false}
      />,
    );
    const panel = await screen.findByRole("dialog", { name: "Drums sound" });
    expect(within(panel).getByRole("slider", { name: "Pitch" })).toBeInTheDocument();
    expect(within(panel).queryByRole("slider", { name: "Attack" })).toBeNull();
  });

  it("keeps one panel open at a time and does not capture Space", async () => {
    setup();
    await openBass();
    await userEvent.click(screen.getByRole("button", { name: /^Sound for Drums/ }));
    expect(await screen.findByRole("dialog", { name: "Drums sound" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const knob = screen.getByRole("slider", { name: "Filter cutoff" });
    expect(fireEvent.keyDown(knob, { key: " ", code: "Space" })).toBe(true);
  });

  it("closes on Escape and returns focus to the Sound button", async () => {
    setup();
    await openBass();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /^Sound for Bass/ })).toHaveFocus();
  });

  it("opens from the track menu and returns focus to the menu trigger on Escape", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Track options for Bass" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Sound…" }));
    const panel = await screen.findByRole("dialog", { name: "Bass sound" });
    await waitFor(() => expect(panel).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Track options for Bass" })).toHaveFocus();
  });

  it("resets every setting as one undo step", async () => {
    const { store, bassSound } = setup({ tone: { filter_cutoff_hz: 300 }, effects: { delay: { enabled: true } } });
    const panel = await openBass();
    await userEvent.click(within(panel).getByRole("button", { name: "Reset sound" }));
    expect(bassSound()).toBeUndefined();
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(bassSound()).toEqual({ tone: { filter_cutoff_hz: 300 }, effects: { delay: { enabled: true } } });
  });

  it("toggles an effect as one step and drops the field when switched back off", async () => {
    const { store, bassSound } = setup();
    const panel = await openBass();
    await userEvent.click(within(panel).getByRole("switch", { name: "Reverb" }));
    expect(bassSound()).toEqual({ effects: { reverb: { enabled: true } } });
    expect(store.getState().past).toHaveLength(1);
    await userEvent.click(within(panel).getByRole("switch", { name: "Reverb" }));
    expect(bassSound()).toBeUndefined();
  });

  it("stores a chosen delay time", async () => {
    const { bassSound } = setup();
    const panel = await openBass();
    await userEvent.click(within(panel).getByRole("radio", { name: "Quarter" }));
    expect(bassSound()).toEqual({ effects: { delay: { time: "1/4" } } });
  });
});

describe("Sound panel knobs", () => {
  it("steps the Reverb mix with the arrow keys and announces the value", async () => {
    const { bassSound } = setup();
    const panel = await openBass();
    const mix = within(panel).getByRole("slider", { name: "Reverb Mix" });
    expect(mix).toHaveAttribute("aria-valuetext", "30%");
    mix.focus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(mix).toHaveAttribute("aria-valuetext", "33%");
    expect(bassSound()).toEqual({ effects: { reverb: { mix: 0.33 } } });
  });

  it("resets the cutoff to the Bass preset default on double-click", async () => {
    const { bassSound } = setup({ tone: { filter_cutoff_hz: 300 } });
    const panel = await openBass();
    const cutoff = within(panel).getByRole("slider", { name: "Filter cutoff" });
    expect(cutoff).toHaveAttribute("aria-valuetext", "300 Hz");
    await userEvent.dblClick(cutoff);
    expect(cutoff).toHaveAttribute("aria-valuetext", "900 Hz");
    expect(bassSound()).toBeUndefined();
  });

  it("resets with Delete", async () => {
    const { bassSound } = setup({ effects: { reverb: { mix: 0.8 } } });
    const panel = await openBass();
    within(panel).getByRole("slider", { name: "Reverb Mix" }).focus();
    await userEvent.keyboard("{Delete}");
    expect(bassSound()).toBeUndefined();
  });

  it("keeps a knob adjustable while its effect is off, and says which switch governs it", async () => {
    setup();
    const panel = await openBass();
    const mix = within(panel).getByRole("slider", { name: "Reverb Mix" });
    expect(mix).not.toHaveAttribute("aria-disabled");
    expect(mix.getAttribute("aria-describedby")).toBe(within(panel).getByRole("switch", { name: "Reverb" }).id);
  });
});
