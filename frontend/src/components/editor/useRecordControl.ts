import { useCallback } from "react";
import type { InputPermission } from "@/lib/audio/recorder/inputManager";
import type { Playback } from "@/lib/audio/types";
import type { AudioTakeRefusal } from "@/lib/recording/audioTake";
import { MAX_SAMPLES, MAX_TAKES_PER_TRACK, RECORDING_ORIGIN } from "@/lib/song/audioTiming";
import type { Song, Track } from "@/lib/song/types";
import type { MidiAccess } from "@/lib/midi/access";
import { useMidiState } from "./useMidiState";

export type RecordingState = "idle" | "counting-in" | "recording";

export const RECORD_NEEDS_MIDI = "Connect a MIDI keyboard to record.";
export const RECORD_LOADING = "Loading sounds…";
export const RECORD_MIC_BLOCKED = "Microphone access is blocked. Allow it in your browser's site settings to record audio.";
export const RECORD_NO_INPUT = "No audio input found. Connect a microphone or interface to record.";
export const RECORD_AUDIO_UNSUPPORTED = "This browser can't record audio.";
export const RECORD_SAMPLES_FULL =
  "This song has 256 samples, the most it can hold. Remove unused samples or takes to record more.";
export const RECORD_NO_SPACE = "Not enough browser storage to record. Remove unused samples or takes, then try again.";
export const RECORD_AUDIO_FAILED = "The audio input couldn't be opened.";
export const recordTakesFull = (trackName: string) =>
  `${trackName} has 64 takes, the most a track can hold. Delete unused takes to record more.`;

// Only instrument tracks are played from a keyboard; an audio track is recorded from its input.
export const needsMidi = (track: { instrument: string } | null | undefined) => track?.instrument !== "audio";

// Shared by the Record button and the R shortcut so both refuse, and explain, the same way.
export function useRecordControl({
  playback,
  recording,
  onRecordToggle,
  onAnnounce,
  midi,
  blockedReason,
  needsMidi: needsMidiInput = true,
  onBlocked,
}: {
  playback: Pick<Playback, "status">;
  recording: RecordingState;
  onRecordToggle?: () => void;
  onAnnounce?: (msg: string) => void;
  midi?: MidiAccess;
  // For a page that has nothing to record onto, so a press explains itself instead of silently doing nothing.
  blockedReason?: string | null;
  // False when the selected track records from an audio input, so a missing keyboard is no reason to refuse.
  needsMidi?: boolean;
  // Lets a page show the fix as well as say it, since a sentence in the status line is easy to miss.
  onBlocked?: (reason: string) => void;
}) {
  const { snapshot } = useMidiState(midi);
  // Ending a take or cancelling a count-in must stay possible whatever else changed.
  const active = recording !== "idle";
  const reason =
    active
      ? null
      : blockedReason
        ? blockedReason
        : needsMidiInput && snapshot.status !== "granted"
        ? RECORD_NEEDS_MIDI
        : playback.status === "loading"
          ? RECORD_LOADING
          : null;

  const toggleRecord = useCallback(() => {
    if (reason) {
      onAnnounce?.(reason);
      onBlocked?.(reason);
    } else onRecordToggle?.();
  }, [reason, onAnnounce, onBlocked, onRecordToggle]);

  return { reason, toggleRecord };
}

// Conditions knowable without touching the input, so Record can say so before the user presses it. Permission not
// yet asked is deliberately not here: pressing Record is what asks.
export function audioRecordBlockedReason(song: Song, track: Track, permission: InputPermission): string | null {
  if (permission === "denied") return RECORD_MIC_BLOCKED;
  if (permission === "unavailable") return RECORD_AUDIO_UNSUPPORTED;
  const samples = song.samples ?? [];
  if (samples.filter((s) => s.origin === RECORDING_ORIGIN && s.track_id === track.id).length >= MAX_TAKES_PER_TRACK)
    return recordTakesFull(track.name);
  if (samples.length >= MAX_SAMPLES) return RECORD_SAMPLES_FULL;
  return null;
}

export function refusalMessage(reason: AudioTakeRefusal, trackName: string): string {
  switch (reason) {
    case "denied":
      return RECORD_MIC_BLOCKED;
    case "unavailable":
      return RECORD_AUDIO_UNSUPPORTED;
    case "no-input":
      return RECORD_NO_INPUT;
    case "takes-full":
      return recordTakesFull(trackName);
    case "samples-full":
      return RECORD_SAMPLES_FULL;
    case "no-space":
      return RECORD_NO_SPACE;
    case "failed":
      return RECORD_AUDIO_FAILED;
  }
}
