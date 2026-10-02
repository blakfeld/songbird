import { useMemo } from "react";
import type { Sample } from "@/generated/Sample";
import { clipSampleName, type SampleLibraryEntry } from "@/lib/audio/sampleLibrary";
import * as ops from "@/lib/song/audioClipOps";
import type { AudioFailure } from "@/lib/song/audioClipOps";
import { formatPosition, spanLabel } from "@/lib/song/audioTime";
import { MAX_SAMPLES, TICKS_PER_SIXTEENTH, clipEndTicks, sampleMap } from "@/lib/song/audioTiming";
import { MAX_TRACKS, MEASURE_RANGE, type Song, type Track } from "@/lib/song/types";
import type { SongStore } from "@/lib/song/songStore";

export const toSample = (e: SampleLibraryEntry): Sample => ({
  id: e.id,
  name: clipSampleName(e.name) || "Sample",
  sample_rate: e.sampleRate,
  channels: e.channels,
  length_samples: e.length,
  origin: "import",
});

export interface AudioActions {
  select(trackId: string, clipId: string | null): void;
  // Transient moves are one undo step with the gesture that surrounds them.
  move(trackId: string, clipId: string, startTicks: number, free: boolean): void;
  trimStart(trackId: string, clipId: string, startTicks: number, free: boolean): void;
  trimEnd(trackId: string, clipId: string, endTicks: number, free: boolean): void;
  gain(trackId: string, clipId: string, db: number, transient?: boolean): void;
  fades(trackId: string, clipId: string, fades: { fadeIn?: number; fadeOut?: number }, transient?: boolean): void;
  // Keys: held auto-repeat shares one gesture, so these are transient too.
  nudge(trackId: string, clipId: string, direction: -1 | 1): void;
  stretch(trackId: string, clipId: string, direction: -1 | 1): void;
  gainStep(trackId: string, clipId: string, delta: number): void;
  loop(trackId: string, clipId: string, on: boolean): void;
  duplicate(trackId: string, clipId: string, options?: { focus?: boolean }): void;
  remove(trackId: string, clipId: string, options?: { focus?: boolean }): void;
  replace(trackId: string, clipId: string, entry: SampleLibraryEntry): void;
  // A null track keeps one undo step for the new track and its clip, which two separate calls could not.
  place(trackId: string | null, entry: SampleLibraryEntry, startTicks: number): boolean;
  placeMany(
    trackId: string | null,
    entries: SampleLibraryEntry[],
    startTicks: number,
    source: "library" | "import",
  ): boolean;
  beginGesture(): void;
  endGesture(): void;
  cancelGesture(): void;
  openDock(): void;
  announce(message: string): void;
  // Set by the page, which owns the picker and the import pipeline.
  requestReplace(trackId: string, clipId: string, invoker?: HTMLElement | null): void;
  importHere(trackId: string | null, startTicks: number | null, options?: { single?: boolean }): void;
}

export function refusal(reason: AudioFailure | "generating", where: string, song: Song): string {
  switch (reason) {
    case "no-room":
      return `the space ${where} is taken.`;
    case "song-limit":
      return `it would make the song longer than ${MEASURE_RANGE.max} measures.`;
    case "clip-limit":
      return "that track already holds the most clips it can.";
    case "sample-limit":
      return `a song can use at most ${MAX_SAMPLES} samples.`;
    case "track-limit":
      return `a song can have at most ${MAX_TRACKS} tracks.`;
    case "generating":
      return "that track is being generated.";
    default:
      void song;
      return "that clip is no longer there.";
  }
}

const clipsOf = (t: Track | undefined) => t?.audio_clips ?? [];
const focusLater = (selector: string) =>
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
const focusClip = (id: string) => focusLater(`[data-audio-clip-id="${id}"]`);

export function useAudioActions(
  store: SongStore,
  announce: (message: string) => void,
  guardEdit: (edit: () => void) => void,
  openDock: () => void,
  hooks: {
    requestReplace: (trackId: string, clipId: string, invoker: HTMLElement | null) => void;
    importHere: (trackId: string | null, startTicks: number | null, options?: { single?: boolean }) => void;
  },
): AudioActions {
  const { requestReplace, importHere } = hooks;
  return useMemo<AudioActions>(() => {
    const state = () => store.getState();
    const find = (trackId: string, clipId: string) => {
      const song = state().song;
      const track = song?.tracks.find((t) => t.id === trackId);
      const clip = clipsOf(track).find((c) => c.id === clipId);
      const sample = clip && song ? sampleMap(song.samples).get(clip.sample_id) : undefined;
      return { song, track, clip, sample };
    };
    const edit = (
      trackId: string,
      fn: (s: Song) => ops.AudioOpResult & { trackId?: string },
      transient = false,
    ) => state().audioEdit(trackId, fn, { transient });
    const label = (trackId: string, clipId: string) => {
      const { song, clip, sample } = find(trackId, clipId);
      return song && clip && sample ? `${sample.name}, ${spanLabel(clip, sample.sample_rate, song)}` : "";
    };
    const say = (trackId: string, clipId: string) => announce(label(trackId, clipId));
    const stepTicks = TICKS_PER_SIXTEENTH;

    const api: AudioActions = {
      select: (trackId, clipId) => {
        if (clipId) state().selectClip(clipId);
        else state().selectTrack(trackId);
      },
      move: (trackId, clipId, startTicks, free) => {
        edit(trackId, (s) => ops.moveClip(s, trackId, clipId, startTicks, free), true);
      },
      trimStart: (trackId, clipId, startTicks, free) => {
        edit(trackId, (s) => ops.trimStart(s, trackId, clipId, startTicks, free), true);
      },
      trimEnd: (trackId, clipId, endTicks, free) => {
        edit(trackId, (s) => ops.setEnd(s, trackId, clipId, endTicks, free), true);
      },
      gain: (trackId, clipId, db, transient = true) => {
        edit(trackId, (s) => ops.setGain(s, trackId, clipId, db), transient);
      },
      fades: (trackId, clipId, fades, transient = true) => {
        edit(trackId, (s) => ops.setFades(s, trackId, clipId, fades), transient);
      },
      nudge: (trackId, clipId, direction) => {
        const before = find(trackId, clipId);
        if (!before.clip) return;
        state().selectClip(clipId);
        edit(trackId, (s) => ops.moveClip(s, trackId, clipId, before.clip!.start_ticks + direction * stepTicks, false), true);
        const after = find(trackId, clipId);
        if (after.clip?.start_ticks === before.clip.start_ticks) announce("Can't move further.");
        else say(trackId, clipId);
      },
      stretch: (trackId, clipId, direction) => {
        const before = find(trackId, clipId);
        if (!before.clip || !before.sample || !before.song) return;
        state().selectClip(clipId);
        const end = clipEndTicks(before.clip, before.sample.sample_rate, before.song.tempo_bpm);
        edit(trackId, (s) => ops.setEnd(s, trackId, clipId, end + direction * stepTicks, false), true);
        const after = find(trackId, clipId);
        if (after.clip?.length_samples === before.clip.length_samples)
          announce(direction > 0 ? "Can't lengthen further." : "Can't shorten further.");
        else say(trackId, clipId);
      },
      gainStep: (trackId, clipId, delta) => {
        const before = find(trackId, clipId);
        if (!before.clip) return;
        state().selectClip(clipId);
        edit(trackId, (s) => ops.setGain(s, trackId, clipId, before.clip!.gain_db + delta), true);
        const after = find(trackId, clipId);
        if (after.clip) announce(`Gain ${after.clip.gain_db} dB`);
      },
      loop: (trackId, clipId, on) => {
        edit(trackId, (s) => ops.setLoop(s, trackId, clipId, on));
        announce(on ? "Looping on." : "Looping off. The clip is limited to its slice.");
      },
      duplicate: (trackId, clipId, options) => {
        const focus = options?.focus ?? document.activeElement?.hasAttribute("data-audio-clip-id");
        const failure = edit(trackId, (s) => ops.duplicateClip(s, trackId, clipId));
        if (failure) {
          announce(`Couldn't duplicate: ${refusal(failure, "after this clip", state().song!)}`);
          return;
        }
        const id = state().selectedClipId;
        if (id) {
          if (focus) focusClip(id);
          say(trackId, id);
        }
      },
      remove: (trackId, clipId, options) => {
        const { track } = find(trackId, clipId);
        if (!track) return;
        const name = label(trackId, clipId);
        const hadFocus = options?.focus ?? document.activeElement?.getAttribute("data-audio-clip-id") === clipId;
        const list = clipsOf(track);
        const index = list.findIndex((c) => c.id === clipId);
        const successor = list[index + 1] ?? list[index - 1];
        if (edit(trackId, (s) => ops.deleteClip(s, trackId, clipId))) return;
        if (state().selectedClipId === clipId || hadFocus) {
          if (successor) state().selectClip(successor.id);
          else state().selectTrack(trackId);
        }
        if (hadFocus) {
          if (successor) focusClip(successor.id);
          else focusLater(`[data-track-select="${trackId}"]`);
        }
        announce(`Deleted ${name}. Undo to restore.`);
      },
      replace: (trackId, clipId, entry) => {
        const sample = toSample(entry);
        const before = find(trackId, clipId);
        const failure = edit(trackId, (s) => ops.replaceSample(s, trackId, clipId, sample));
        if (failure) {
          announce(`Couldn't replace the sample: ${refusal(failure, "after this clip", state().song!)}`);
          return;
        }
        const after = find(trackId, clipId);
        const shortened =
          before.clip && after.clip && after.clip.length_samples < before.clip.length_samples && !after.clip.loop;
        announce(
          `Replaced ${before.sample?.name ?? "the sample"} with ${sample.name}.${shortened ? " Clip shortened to fit." : ""}`,
        );
      },
      placeMany: (trackId, entries, startTicks, source) => {
        if (entries.length === 0) return false;
        const samples = entries.map(toSample);
        const before = state().song;
        if (!before) return false;
        let outcome: ops.SequenceResult | null = null;
        const failure = edit(trackId ?? "", (s) => {
          outcome = ops.placeSequence(s, trackId, samples, startTicks);
          return outcome.song
            ? { song: outcome.song, clipId: outcome.clipId, trackId: outcome.trackId }
            : { song: null, reason: outcome.reason };
        });
        const result = outcome as ops.SequenceResult | null;
        const now = state().song;
        const nameOf = (id: string | null) =>
          (id ? (now ?? before).tracks.find((t) => t.id === id)?.name : undefined) ?? "the track";
        const explain = (reason: AudioFailure | "generating", sample: Sample, at: number, id: string | null) => {
          const where = `at ${formatPosition(at, before)} on ${nameOf(id)}`;
          const why = refusal(reason, id === null ? "there" : where, before);
          return source === "import"
            ? `Imported ${sample.name} to the library, but couldn't place it: ${why}`
            : `Couldn't place ${sample.name}: ${why}`;
        };
        if (failure || !result || !result.song) {
          const reason = failure ?? (result && !result.song ? result.reason : "not-found");
          announce(explain(reason, samples[0], Math.round(startTicks), trackId));
          return false;
        }
        const id = result.trackId;
        const position = formatPosition(Math.round(startTicks), before);
        if (result.stopped)
          announce(
            `Placed ${result.placed} of ${samples.length}. ${explain(result.stopped.reason, result.stopped.sample, result.stopped.startTicks, id)}`,
          );
        else
          announce(
            result.placed === 1
              ? `Placed ${samples[0].name} on ${nameOf(id)} at ${position}.`
              : `Placed ${result.placed} samples on ${nameOf(id)} from ${position}.`,
          );
        const selected = state().selectedClipId;
        if (selected) focusClip(selected);
        return true;
      },
      place: (trackId, entry, startTicks) => api.placeMany(trackId, [entry], startTicks, "library"),
      beginGesture: () => guardEdit(() => state().beginGesture()),
      endGesture: () => state().endGesture(),
      cancelGesture: () => state().cancelGesture(),
      openDock,
      announce,
      requestReplace: (trackId, clipId, invoker) =>
        requestReplace(trackId, clipId, invoker ?? (document.activeElement as HTMLElement | null)),
      importHere,
    };
    return api;
  }, [store, announce, guardEdit, openDock, requestReplace, importHere]);
}
