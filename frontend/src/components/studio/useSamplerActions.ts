import { useMemo } from "react";
import type { Row } from "@/generated/Row";
import type { SampleLibraryEntry } from "@/lib/audio/sampleLibrary";
import { MAX_SAMPLES, sampleMap } from "@/lib/song/audioTiming";
import { PAD_COUNT, noteName, padIndex } from "@/lib/song/sampler";
import * as ops from "@/lib/song/samplerOps";
import type { SongState, SongStore } from "@/lib/song/songStore";
import { toSample } from "./useAudioActions";

// Where a pick or an import lands: the keys sample, or a pad row, which is where a multi-file drop starts.
export type SamplerTarget = { trackId: string; rowId: string | null };

// Which sampler targets an import is filling and how far along it is; `rowIds` is empty for the keys sample.
export interface SamplerImporting {
  trackId: string;
  rowIds: string[];
  percent: number;
}

export interface SamplerActions {
  chooseKeys(trackId: string, entry: SampleLibraryEntry): void;
  clearKeys(trackId: string): void;
  setRoot(trackId: string, note: number): void;
  setOneShot(trackId: string, on: boolean): void;
  // Several entries fill the pads from `rowId` down, as one undo step.
  assignPads(trackId: string, rowId: string, entries: SampleLibraryEntry[], source?: "library" | "import"): void;
  clearPad(trackId: string, rowId: string): void;
  // A knob drag is transient edits inside a gesture, so it is one undo step.
  padGain(trackId: string, rowId: string, db: number, transient?: boolean): void;
  padPitch(trackId: string, rowId: string, semitones: number, transient?: boolean): void;
  beginGesture(): void;
  endGesture(): void;
  audition(trackId: string, row: Row): void;
  // Both are the page's, which owns the picker dialog and the import pipeline.
  requestPick(target: SamplerTarget, invoker: HTMLElement | null): void;
  importDropped(target: SamplerTarget, files: File[]): void;
  announce(message: string): void;
}

export type SamplerEdits = Omit<SamplerActions, "requestPick" | "importDropped">;

const REFUSALS: Record<ops.SamplerFailure, string> = {
  "not-found": "that track is no longer in the song.",
  "wrong-kind": "that track is not that kind of sampler.",
  "sample-limit": `a song can use at most ${MAX_SAMPLES} samples.`,
  "track-limit": "a song can have at most 16 tracks.",
};

const padName = (rowId: string) => `Pad ${padIndex(rowId) + 1}`;
const list = (names: string[]) =>
  names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, ${names[names.length - 1]}`;

export function useSamplerActions(
  store: SongStore,
  announce: (message: string) => void,
  guardEdit: (edit: () => void) => void,
  audition: SamplerActions["audition"],
): SamplerEdits {
  return useMemo<SamplerEdits>(() => {
    const state = () => store.getState();
    const track = (trackId: string) => state().song?.tracks.find((t) => t.id === trackId);
    const nameOf = (id: string | null | undefined) => {
      const song = state().song;
      return (id && song ? sampleMap(song.samples).get(id)?.name : undefined) ?? "the sample";
    };
    const run = (
      fn: Parameters<SongState["samplerEdit"]>[0],
      options?: { transient?: boolean },
    ) => state().samplerEdit(fn, options);

    return {
      chooseKeys: (trackId, entry) => {
        const sample = toSample(entry);
        const failure = run((s) => ops.chooseKeysSample(s, trackId, sample));
        if (failure) announce(`Couldn't choose ${sample.name}: ${REFUSALS[failure]}`);
        else announce(`${track(trackId)?.name ?? "Sampler"} plays ${sample.name}.`);
      },
      clearKeys: (trackId) => {
        const t = track(trackId);
        const before = nameOf(t?.sampler?.keys?.sample_id);
        if (!t?.sampler?.keys?.sample_id) return;
        run((s) => ops.clearKeysSample(s, trackId));
        announce(`Cleared ${before} from ${t.name}.`);
      },
      setRoot: (trackId, note) => {
        run((s) => ops.setRootNote(s, trackId, note));
        announce(`Root note ${noteName(note)}.`);
      },
      setOneShot: (trackId, on) => {
        run((s) => ops.setOneShot(s, trackId, on));
        announce(on ? "One-shot on." : "One-shot off.");
      },
      assignPads: (trackId, rowId, entries, source = "library") => {
        if (entries.length === 0) return;
        const samples = entries.map(toSample);
        const t = track(trackId);
        const first = padIndex(rowId);
        const replaced = t?.sampler?.pads?.find((p) => p.row_id === rowId);
        let outcome: ops.PadsResult | null = null;
        const failure = run((s) => (outcome = ops.assignPads(s, trackId, rowId, samples)));
        const result = outcome as ops.PadsResult | null;
        if (failure || !result?.song) {
          const why = REFUSALS[failure ?? "not-found"];
          announce(
            source === "import"
              ? `Imported ${samples[0].name} to the library, but couldn't assign it: ${why}`
              : `Couldn't assign ${samples[0].name}: ${why}`,
          );
          return;
        }
        const placed = result.assigned.length;
        const fit = Math.max(0, PAD_COUNT - first);
        const left = samples.length - Math.min(samples.length, fit);
        const names = result.assigned.map((a) => a.sample.name);
        const message =
          placed === 1
            ? `${padName(rowId)} is now ${names[0]}${replaced ? `, replacing ${nameOf(replaced.sample_id)}` : ""}.`
            : `Pads ${first + 1} to ${first + placed} are now ${list(names)}.`;
        const spill =
          left > 0
            ? ` ${left} ${left === 1 ? "file" : "files"} didn't fit after Pad ${PAD_COUNT} and stay in the library.`
            : result.stopped
              ? ` The rest couldn't be assigned: ${REFUSALS[result.stopped]}`
              : "";
        announce(message + spill);
      },
      clearPad: (trackId, rowId) => {
        const pad = track(trackId)?.sampler?.pads?.find((p) => p.row_id === rowId);
        if (!pad) return;
        run((s) => ops.clearPad(s, trackId, rowId));
        announce(`Cleared ${padName(rowId)}.`);
      },
      padGain: (trackId, rowId, db, transient = true) => {
        run((s) => ops.setPadGain(s, trackId, rowId, db), { transient });
      },
      padPitch: (trackId, rowId, semitones, transient = true) => {
        run((s) => ops.setPadPitch(s, trackId, rowId, semitones), { transient });
      },
      beginGesture: () => guardEdit(() => state().beginGesture()),
      endGesture: () => state().endGesture(),
      audition,
      announce,
    };
  }, [store, announce, guardEdit, audition]);
}
