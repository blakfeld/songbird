import { useCallback } from "react";
import type { Playback } from "@/lib/audio/types";
import type { MidiAccess } from "@/lib/midi/access";
import { useMidiState } from "./useMidiState";

export type RecordingState = "idle" | "counting-in" | "recording";

export const RECORD_NEEDS_MIDI = "Connect a MIDI keyboard to record.";
export const RECORD_LOADING = "Loading sounds…";

// Shared by the Record button and the R shortcut so both refuse, and explain, the same way.
export function useRecordControl({
  playback,
  recording,
  onRecordToggle,
  onAnnounce,
  midi,
}: {
  playback: Pick<Playback, "status">;
  recording: RecordingState;
  onRecordToggle?: () => void;
  onAnnounce?: (msg: string) => void;
  midi?: MidiAccess;
}) {
  const { snapshot } = useMidiState(midi);
  // Ending a take or cancelling a count-in must stay possible whatever else changed.
  const active = recording !== "idle";
  const reason =
    active
      ? null
      : snapshot.status !== "granted"
        ? RECORD_NEEDS_MIDI
        : playback.status === "loading"
          ? RECORD_LOADING
          : null;

  const toggleRecord = useCallback(() => {
    if (reason) onAnnounce?.(reason);
    else onRecordToggle?.();
  }, [reason, onAnnounce, onRecordToggle]);

  return { reason, toggleRecord };
}
