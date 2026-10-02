import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Row } from "@/generated/Row";
import { SAMPLER_KEYS_ENVELOPE, samplerKindOf, samplerSampleIds } from "@/lib/song/sampler";
import { createSongStore } from "@/lib/song/songStore";
import type { Song } from "@/lib/song/types";
import { stepToSeconds } from "@/lib/timing";
import { createAudioTrackSource, type AudioTrackSource } from "./audioTrackSource";
import { clipEndSeconds, planClip, ticksToSeconds } from "./clipSchedule";
import { createInsertChain } from "./insertChain";
import { getSoundSourceFactory } from "./registry";
import { sharedSampleBuffers, type SampleBufferCache } from "./sampleBuffers";
import { MAX_SAMPLER_VOICES, planSamplerNote } from "./samplerSource";
import { createSongPlaybackModel } from "./songPlaybackModel";
import { encodeWavInWorker } from "./wavEncodeClient";
import type { SoundSource, Voice } from "./types";

type ToneModule = typeof import("tone");
type ToneBuffer = InstanceType<ToneModule["ToneAudioBuffer"]>;

// Long enough that one segment's memory and render time stay modest, short enough that Cancel responds.
export const SEGMENT_SECONDS = 30;
// Delay and reverb tails run on from earlier audio, so each segment starts this far early and discards that part.
export const PRE_ROLL_SECONDS = 4;
export const TAIL_SECONDS = 4;
// Below this the tail is inaudible, so keeping it would only lengthen the file with silence.
const TAIL_FLOOR = 10 ** (-60 / 20);
const CHANNELS = 2;

export interface MixdownOptions {
  // Rows come from the instrument list, which the song itself does not carry.
  instruments: InstrumentInfo[];
  loadTone?: () => Promise<ToneModule>;
  sampleBuffers?: SampleBufferCache;
  // Exposed so a test can render in one piece and compare, which is the only way to prove the stitching is clean.
  segmentSeconds?: number;
  preRollSeconds?: number;
}

export interface Mixdown {
  wav: Blob;
  // The mix reached full scale somewhere, so the caller should warn after the download.
  clipped: boolean;
  seconds: number;
}

function abortError() {
  return new DOMException("The render was cancelled.", "AbortError");
}

// Lets a caller tell Cancel from a real failure, since Cancel must not show an error.
export const isMixdownCancelled = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

// Renders from a snapshot so edits made while it runs are not in the file. Progress is 0..1 and Cancel is checked
// between segments, because an offline render cannot be interrupted once it has begun.
export async function renderMixdown(
  song: Song,
  onProgress: (fraction: number) => void,
  signal: AbortSignal | undefined,
  options: MixdownOptions,
): Promise<Mixdown> {
  const checkCancelled = () => {
    if (signal?.aborted) throw abortError();
  };
  checkCancelled();

  const snapshot: Song = JSON.parse(JSON.stringify(song));
  const model = createSongPlaybackModel(createSongStore(snapshot), options.instruments);
  // Muted and soloed-out tracks are left out entirely, not rendered silent, so they cost no time.
  const voices = model.getVoices().filter((v) => v.audible);
  const tempo = snapshot.tempo_bpm;
  const swing = snapshot.swing;

  const tone = await (options.loadTone ?? (() => import("tone")))();
  const sampleRate = tone.getContext().sampleRate;
  const cache = options.sampleBuffers ?? sharedSampleBuffers(tone);
  const sampleIds = [
    ...new Set(
      voices.flatMap((v) => [...(v.clips?.map((c) => c.clip.sample_id) ?? []), ...samplerSampleIds({ sampler: v.sampler })]),
    ),
  ];
  cache.acquire(sampleIds);
  try {
    await cache.load(sampleIds);
    checkCancelled();

    const clipEnds = voices.flatMap((v) => v.clips?.map((c) => clipEndSeconds(c, tempo)) ?? []);
    const songSeconds = Math.max(stepToSeconds(snapshot.measures * snapshot.steps_per_measure, tempo, 0), ...clipEnds);
    const songFrames = Math.ceil(songSeconds * sampleRate);
    const totalFrames = songFrames + Math.ceil(TAIL_SECONDS * sampleRate);
    const segmentFrames = Math.round((options.segmentSeconds ?? SEGMENT_SECONDS) * sampleRate);
    const preRollFrames = Math.round((options.preRollSeconds ?? PRE_ROLL_SECONDS) * sampleRate);
    const segments = Math.ceil(totalFrames / segmentFrames);

    // Frames each note sounds over, so a window can begin early enough to take a long note from its own start.
    const spans = voices
      .filter((v) => v.kind !== "audio")
      .flatMap((v) => {
        const kind = samplerKindOf(v.instrument);
        return v.notes.map((n) => {
          const from = Math.floor(stepToSeconds(n.step, tempo, swing) * sampleRate);
          const to = Math.ceil(stepToSeconds(n.step + n.length_steps, tempo, swing) * sampleRate);
          // Only a held key's release is phase-continuous with its note. A one-shot's ring is not stretched into the span,
          // because dense one-shots would chain every window back to the start; `scheduleNotes` joins them mid-sample.
          const release = kind === "keys" ? (v.sound?.tone.envelope?.release ?? SAMPLER_KEYS_ENVELOPE.release) : 0;
          return { from, to: to + Math.ceil(release * sampleRate) };
        });
      });

    const mix = Array.from({ length: CHANNELS }, () => new Float32Array(totalFrames));
    onProgress(0);
    for (let k = 0; k < segments; k++) {
      checkCancelled();
      const keptStart = k * segmentFrames;
      const keptEnd = Math.min(keptStart + segmentFrames, totalFrames);
      const windowStart = earliestSounding(spans, Math.max(0, keptStart - preRollFrames));
      const rendered = await renderSegment(tone, cache, voices, {
        tempo,
        swing,
        sampleRate,
        windowStart: windowStart / sampleRate,
        windowSeconds: (keptEnd - windowStart) / sampleRate,
      });
      const skip = keptStart - windowStart;
      for (let c = 0; c < CHANNELS; c++) {
        const source = rendered.getChannelData(c);
        mix[c].set(source.subarray(skip, Math.min(source.length, skip + keptEnd - keptStart)), keptStart);
      }
      onProgress((k + 1) / segments);
    }
    checkCancelled();

    // A tail is kept only as far as it is audible, but never cuts into the song itself.
    let end = totalFrames;
    while (end > songFrames && mix.every((ch) => Math.abs(ch[end - 1]) < TAIL_FLOOR)) end -= 1;
    const trimmed = mix.map((ch) => ch.subarray(0, end));
    const { bytes, clipped } = await encodeWavInWorker(trimmed, sampleRate);
    return { wav: new Blob([bytes as BlobPart], { type: "audio/wav" }), clipped, seconds: end / sampleRate };
  } finally {
    cache.release(sampleIds);
  }
}

// A held note restarted at a window's edge would have a different oscillator phase than the same note rendered
// whole, so the window begins at the start of any note still sounding there.
function earliestSounding(spans: { from: number; to: number }[], start: number) {
  let earliest = start;
  for (let moved = true; moved; ) {
    moved = false;
    for (const span of spans) {
      if (span.from < earliest && span.to > earliest) {
        earliest = span.from;
        moved = true;
      }
    }
  }
  return earliest;
}

interface Segment {
  tempo: number;
  swing: number;
  sampleRate: number;
  // A segment renders only its slice of the song, so its own zero has to be mapped back to song time.
  windowStart: number;
  windowSeconds: number;
}

interface Built {
  voice: Voice;
  input: import("tone").InputNode;
  source: SoundSource;
}

// Tone builds every node in whatever its global context is, and a live engine ticking in the meantime would build
// its nodes in this render's context. So the global is swapped only for synchronous stretches, never across an await.
function within<T>(tone: ToneModule, context: InstanceType<ToneModule["OfflineContext"]>, build: () => T): T {
  const live = tone.getContext();
  tone.setContext(context);
  try {
    return build();
  } finally {
    tone.setContext(live);
  }
}

// Each track gets the live graph (source, insert chain, channel with its volume and pan), so the file matches
// what the studio plays.
async function renderSegment(
  tone: ToneModule,
  cache: SampleBufferCache,
  voices: Voice[],
  segment: Segment,
): Promise<ToneBuffer> {
  const context = new tone.OfflineContext(CHANNELS, segment.windowSeconds, segment.sampleRate);
  const disposers: (() => void)[] = [];
  try {
    const chains: { ready(): Promise<void> }[] = [];
    const built = within(tone, context, () =>
      voices.map((voice): Built => {
        const channel = new tone.Channel({ volume: voice.volumeDb, pan: voice.pan }).toDestination();
        const chain = createInsertChain(tone);
        chain.output.connect(channel);
        if (voice.sound) chain.apply(voice.sound.effects, segment.tempo);
        chains.push(chain);
        const source =
          voice.kind === "audio"
            ? createAudioTrackSource(tone, chain.input, () => 0)
            : getSoundSourceFactory(voice.instrument)(tone, chain.input, voice.sound?.tone);
        if (voice.sampler) source.setSamples?.(voice.sampler, cache);
        disposers.push(() => {
          if (source.dispose) source.dispose();
          else source.stopAll();
          channel.dispose();
          chain.dispose();
        });
        return { voice, input: chain.input, source };
      }),
    );
    // Slow work happens here, with the live context restored: a reverb's impulse response and a kit's samples.
    await Promise.all([
      ...chains.map((chain) => chain.ready()),
      ...built.map(({ voice, source }) => source.load(voice.rows)),
    ]);
    within(tone, context, () => {
      for (const { voice, source } of built) {
        if (voice.kind === "audio") scheduleClips(cache, voice, source as AudioTrackSource, segment);
        else scheduleNotes(voice, source, segment, cache);
      }
    });
    return await context.render();
  } finally {
    disposers.forEach((dispose) => dispose());
  }
}

function scheduleNotes(
  voice: Voice,
  source: SoundSource,
  { tempo, swing, windowStart, windowSeconds }: Segment,
  cache: SampleBufferCache,
) {
  const kind = samplerKindOf(voice.instrument);
  const resumed: { row: Row; start: number; end: number; velocity: number }[] = [];
  const later: (() => void)[] = [];
  for (const note of voice.notes) {
    const row = voice.rows.find((r) => r.id === note.row_id);
    if (!row) continue;
    const start = stepToSeconds(note.step, tempo, swing) - windowStart;
    const end = stepToSeconds(note.step + note.length_steps, tempo, swing) - windowStart;
    // A one-shot that began before the window is still sounding, so it resumes part-way into its sample.
    const plan = kind ? planSamplerNote(kind, voice.sampler ?? {}, row, note.velocity, voice.sound?.tone.pitchSemitones ?? 0) : null;
    if (plan && !plan.sustained && start < 0 && start < windowSeconds) {
      const buffer = cache.get(plan.sampleId);
      if (buffer && start + buffer.duration / plan.rate > 0) resumed.push({ row, start, end, velocity: note.velocity });
      continue;
    }
    // Notes are pulled into the window from their own start, so only a rounding edge is ever clamped here.
    if (end <= 0 || start >= windowSeconds) continue;
    later.push(() => source.trigger(row, Math.max(start, 0), end, note.velocity));
  }
  // The whole render would have stolen the oldest ringing notes before this window opened, so only the newest
  // few are still sounding at its edge. They go first because a voice pool counts what is scheduled, not what is due.
  resumed.sort((a, b) => a.start - b.start);
  for (const r of resumed.slice(-MAX_SAMPLER_VOICES)) source.trigger(r.row, 0, Math.max(r.end, 0), r.velocity, -r.start);
  for (const play of later) play();
}

function scheduleClips(
  cache: SampleBufferCache,
  voice: Voice,
  track: AudioTrackSource,
  { tempo, windowStart, windowSeconds }: Segment,
) {
  for (const pc of voice.clips ?? []) {
    const start = ticksToSeconds(pc.clip.start_ticks, tempo) - windowStart;
    const length = pc.clip.length_samples / pc.sampleRate;
    if (start + length <= 0 || start >= windowSeconds) continue;
    const buffer = cache.get(pc.clip.sample_id);
    if (!buffer) continue;
    const position = start < 0 ? Math.round(-start * pc.sampleRate) : 0;
    if (planClip(pc, position)) track.playClip(pc, buffer, Math.max(start, 0), position);
  }
}
