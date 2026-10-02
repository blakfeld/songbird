import type { AudioClip } from "@/generated/AudioClip";
import { beatSteps } from "../pianoRoll";
import { TICKS_PER_SIXTEENTH, clipEndTicks } from "./audioTiming";
import type { Song } from "./types";

type Timing = Pick<Song, "steps_per_measure" | "time_signature" | "tempo_bpm">;

function split(ticks: number, song: Timing) {
  const step = Math.floor(ticks / TICKS_PER_SIXTEENTH);
  const beat = beatSteps(song.time_signature);
  const within = step % song.steps_per_measure;
  return {
    measure: Math.floor(step / song.steps_per_measure) + 1,
    beat: Math.floor(within / beat) + 1,
    sixteenth: (within % beat) + 1,
  };
}

export function formatPosition(ticks: number, song: Timing): string {
  const p = split(ticks, song);
  return `${p.measure}.${p.beat}.${p.sixteenth}`;
}

// The end names the beat holding the last sounding frame, so a clip that stops on a barline reads as ending before it.
export function lastFrameTicks(clip: AudioClip, sampleRate: number, song: Timing): number {
  return Math.max(clip.start_ticks, clipEndTicks(clip, sampleRate, song.tempo_bpm) - 1);
}

export function spanLabel(clip: AudioClip, sampleRate: number, song: Timing): string {
  const a = split(clip.start_ticks, song);
  const b = split(lastFrameTicks(clip, sampleRate, song), song);
  return `measure ${a.measure} beat ${a.beat} to measure ${b.measure} beat ${b.beat}`;
}

export function formatFade(samples: number, sampleRate: number): string {
  if (samples <= 0) return "Off";
  const ms = (samples / sampleRate) * 1000;
  if (ms < 1) return "Off";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatLength(samples: number, sampleRate: number): string {
  const tenths = Math.round((samples / sampleRate) * 10);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function formatBarsBeats(ticks: number, song: Timing): string {
  const stepsPerBeat = beatSteps(song.time_signature);
  const beats = Math.round(ticks / TICKS_PER_SIXTEENTH / stepsPerBeat);
  const bars = Math.floor(beats / (song.steps_per_measure / stepsPerBeat));
  const rest = beats - bars * (song.steps_per_measure / stepsPerBeat);
  const part = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [bars > 0 && part(bars, "bar"), rest > 0 && part(rest, "beat")].filter(Boolean).join(" ") || "0 beats";
}
