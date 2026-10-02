import { TICKS_PER_SECOND_PER_BPM } from "@/lib/song/audioTiming";

// Captured when the take begins, so every later frame can be placed relative to the transport without asking the
// engine again.
export interface TakeOrigin {
  contextTime: number;
  // Position in the song, not the transport: the transport also counts the count-in bar and earlier loop passes.
  songSeconds: number;
}

export interface Latencies {
  outputLatency: number;
  baseLatency: number;
  inputLatency: number;
  // Seconds like the other terms, so they can be summed; the setting itself is stored in milliseconds.
  userOffset: number;
}

export const totalLatency = (l: Latencies) => l.outputLatency + l.baseLatency + l.inputLatency + l.userOffset;

export const songSecondsOfFrame = (frame: number, sampleRate: number, origin: TakeOrigin, latencies: Latencies) =>
  frame / sampleRate - origin.contextTime + origin.songSeconds - totalLatency(latencies);

export interface Placement {
  startTicks: number;
  // Samples skipped at the front of the take so nothing lands before the punch-in point.
  offsetSamples: number;
}

// Frames compensated to before `punchSeconds` are cut rather than placed earlier, since a clip must not
// overwrite song time the performer was not recording. Rounding the start tick first and trimming whole samples up
// to it means the audio can only land at or after the punch.
export function placeTake(
  firstFrame: number,
  sampleRate: number,
  tempoBpm: number,
  origin: TakeOrigin,
  latencies: Latencies,
  punchSeconds = origin.songSeconds,
): Placement {
  const perSecond = TICKS_PER_SECOND_PER_BPM * tempoBpm;
  const seconds = songSecondsOfFrame(firstFrame, sampleRate, origin, latencies);
  const punchTicks = Math.round(punchSeconds * perSecond);
  const wantedTicks = Math.round(seconds * perSecond);
  if (wantedTicks >= punchTicks) return { startTicks: Math.max(0, wantedTicks), offsetSamples: 0 };
  const skipSeconds = (punchTicks - seconds * perSecond) / perSecond;
  return { startTicks: Math.max(0, punchTicks), offsetSamples: Math.max(0, Math.round(skipSeconds * sampleRate)) };
}
