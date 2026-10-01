import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Playback } from "@/lib/audio/types";
import { resetMetronomeSettingsForTests, useMetronomeSettings } from "@/lib/audio/useMetronomeSettings";
import { createMidiAccess } from "@/lib/midi/access";
import { createFakeMidi } from "@/test/fakeMidi";
import { Transport } from "./Transport";
import { useShortcuts } from "./useEditorShortcuts";
import { useRecordControl, type RecordingState } from "./useRecordControl";

function makePlayback(over: Partial<Playback> = {}): Playback {
  return {
    isPlaying: false,
    status: "ready",
    error: null,
    toggle: vi.fn(),
    stop: vi.fn(),
    preload: vi.fn(),
    subscribePosition: () => () => {},
    ...over,
  };
}

const grantedAccess = async () => {
  const access = createMidiAccess({
    requestMIDIAccess: createFakeMidi({ inputs: [{ id: "k", name: "KeyStep" }] }).requestMIDIAccess,
    storage: null,
  });
  await access.request();
  return access;
};

const promptAccess = (opts: { deny?: boolean } = {}) =>
  createMidiAccess({ requestMIDIAccess: createFakeMidi(opts).requestMIDIAccess, storage: null });

// Stands in for a page's recording orchestration, which is not Transport's job.
function Harness({
  midi,
  engine,
  announce,
  initialPlaying = false,
}: {
  midi: ReturnType<typeof createMidiAccess>;
  engine: {
    play: (o: { countIn: boolean }) => void;
    stop: () => void;
    countIn: Set<(n: number | null) => void>;
  };
  announce: (m: string) => void;
  initialPlaying?: boolean;
}) {
  const [recording, setRecording] = useState<RecordingState>("idle");
  const [playing, setPlaying] = useState(initialPlaying);
  const { countIn } = useMetronomeSettings();
  const playback = makePlayback({
    isPlaying: playing,
    toggle: () => {
      if (playing || recording === "counting-in") {
        engine.stop();
        setPlaying(false);
        setRecording("idle");
      } else {
        engine.play({ countIn: false });
        setPlaying(true);
      }
    },
  });
  const onRecordToggle = () => {
    if (recording === "idle" && !playing) {
      engine.play({ countIn });
      if (countIn) setRecording("counting-in");
      else {
        setPlaying(true);
        setRecording("recording");
      }
    } else if (recording === "idle") {
      setRecording("recording");
    } else if (recording === "counting-in") {
      engine.stop();
      setRecording("idle");
    } else {
      setRecording("idle");
    }
  };
  const { toggleRecord } = useRecordControl({ playback, recording, onRecordToggle, onAnnounce: announce, midi });
  useShortcuts({ undo: () => {}, redo: () => {}, toggleRecord });
  return (
    <>
      <Transport
        playback={playback}
        onToggle={playback.toggle}
        stepsPerMeasure={16}
        beatSteps={4}
        loop={{ region: null, enabled: false }}
        onLoopChange={() => {}}
        follow
        onFollowChange={() => {}}
        recording={recording}
        onRecordToggle={onRecordToggle}
        subscribeCountIn={(cb) => {
          engine.countIn.add(cb);
          return () => engine.countIn.delete(cb);
        }}
        onAnnounce={announce}
        midi={midi}
      />
      <button onClick={() => { setPlaying(true); setRecording("counting-in"); }}>enter-count-in</button>
      <button onClick={() => { setRecording("recording"); }}>start-take</button>
    </>
  );
}

const makeEngine = () => ({ play: vi.fn(), stop: vi.fn(), countIn: new Set<(n: number | null) => void>() });

beforeEach(() => {
  localStorage.clear();
  resetMetronomeSettingsForTests();
});

describe("Record availability", () => {
  it("is disabled until MIDI access is granted, and says why", async () => {
    const midi = promptAccess();
    const announce = vi.fn();
    const engine = makeEngine();
    render(<Harness midi={midi} engine={engine} announce={announce} />);
    const record = screen.getByRole("button", { name: "Record" });
    expect(record).toHaveAttribute("aria-disabled", "true");
    expect(record).toHaveAccessibleDescription("Connect a MIDI keyboard to record.");

    await userEvent.click(record);
    expect(announce).toHaveBeenCalledWith("Connect a MIDI keyboard to record.");
    expect(engine.play).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Connect MIDI" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).not.toHaveAttribute("aria-disabled"));
    expect(announce).toHaveBeenCalledWith("MIDI connected.");
    expect(screen.getByRole("menuitemradio", { name: "All inputs" })).toHaveFocus();
  });

  it("explains an unsupported browser", () => {
    const midi = createMidiAccess({ requestMIDIAccess: undefined, storage: null });
    render(<Harness midi={midi} engine={makeEngine()} announce={vi.fn()} />);
    expect(screen.getByRole("button", { name: /MIDI not supported/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-disabled", "true");
  });

  it("offers a retry after the browser blocks MIDI", async () => {
    render(<Harness midi={promptAccess({ deny: true })} engine={makeEngine()} announce={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect MIDI" }));
    await userEvent.click(await screen.findByRole("button", { name: /MIDI blocked/ }));
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("R shortcut", () => {
  it("toggles recording from the page body and ignores key repeat", async () => {
    const engine = makeEngine();
    render(<Harness midi={await grantedAccess()} engine={engine} announce={vi.fn()} />);
    fireEvent.keyDown(document.body, { key: "r", repeat: true });
    expect(engine.play).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "r" });
    expect(engine.play).toHaveBeenCalledTimes(1);
  });

  it("is ignored in text fields and dialogs", async () => {
    const engine = makeEngine();
    render(
      <>
        <Harness midi={await grantedAccess()} engine={engine} announce={vi.fn()} />
        <input aria-label="Name" />
        <div role="dialog" aria-label="Dlg">
          <button>inside</button>
        </div>
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "r" });
    fireEvent.keyDown(screen.getByRole("button", { name: "inside" }), { key: "r" });
    fireEvent.keyDown(document.body, { key: "r", ctrlKey: true });
    expect(engine.play).not.toHaveBeenCalled();
  });

  it("announces the reason instead when Record is unavailable", () => {
    const announce = vi.fn();
    render(<Harness midi={promptAccess()} engine={makeEngine()} announce={announce} />);
    fireEvent.keyDown(document.body, { key: "R" });
    expect(announce).toHaveBeenCalledWith("Connect a MIDI keyboard to record.");
  });
});

describe("Metronome and count-in settings", () => {
  it("defaults count-in on and metronome off, and persists across a remount", async () => {
    const midi = await grantedAccess();
    const { unmount } = render(<Harness midi={midi} engine={makeEngine()} announce={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Count-in" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Metronome" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "Count-in" }));
    await userEvent.click(screen.getByRole("button", { name: "Metronome" }));
    expect(JSON.parse(localStorage.getItem("songbird.metronome.v1")!)).toEqual({ metronome: true, countIn: false });
    unmount();

    render(<Harness midi={midi} engine={makeEngine()} announce={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Count-in" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Metronome" })).toHaveAttribute("aria-pressed", "true");
  });

  it("survives storage that throws", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    render(<Harness midi={await grantedAccess()} engine={makeEngine()} announce={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Metronome" }));
    expect(screen.getByRole("button", { name: "Metronome" })).toHaveAttribute("aria-pressed", "true");
    spy.mockRestore();
  });
});

describe("Recording flows", () => {
  it("Record from stopped with count-in", async () => {
    const engine = makeEngine();
    const announce = vi.fn();
    render(<Harness midi={await grantedAccess()} engine={engine} announce={announce} />);
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(engine.play).toHaveBeenCalledWith({ countIn: true });
    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "true");
    expect(announce).toHaveBeenCalledWith("Count-in. Recording starts after one bar.");
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();

    act(() => engine.countIn.forEach((cb) => cb(3)));
    expect(screen.getByText("3")).toBeInTheDocument();
    act(() => engine.countIn.forEach((cb) => cb(null)));
    await userEvent.click(screen.getByText("start-take"));
    expect(screen.getByRole("button", { name: "Record" })).toHaveTextContent("Recording");
  });

  it("Punch in and out while playback continues", async () => {
    const engine = makeEngine();
    render(<Harness midi={await grantedAccess()} engine={engine} announce={vi.fn()} initialPlaying />);
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(engine.play).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Record" })).toHaveTextContent("Recording");
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "false");
    expect(engine.stop).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
  });

  it.each(["Stop", "Record"])("%s during count-in cancels without recording", async (control) => {
    const engine = makeEngine();
    const announce = vi.fn();
    render(<Harness midi={await grantedAccess()} engine={engine} announce={announce} />);
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    await userEvent.click(screen.getByRole("button", { name: control === "Stop" ? /Stop/ : "Record" }));
    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Record" })).toHaveTextContent("Record");
    expect(announce).toHaveBeenCalledWith("Count-in cancelled. Nothing was recorded.");
  });
});
