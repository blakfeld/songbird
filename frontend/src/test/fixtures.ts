import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Note } from "@/generated/Note";
import type { Pattern } from "@/generated/Pattern";
import { emptyPattern } from "@/lib/patternOps";
import type { Track } from "@/lib/song/types";

export const drums: InstrumentInfo = {
  id: "drums",
  name: "Drums",
  kind: "drums",
  midi_program: null,
  range: null,
  midi_channel: 10,
  sustained: false,
  rows: [
    { id: "kick", name: "Kick", midi_note: 36 },
    { id: "snare", name: "Snare", midi_note: 38 },
    { id: "hat_closed", name: "Closed Hi-Hat", midi_note: 42 },
  ],
};

export const note = (row_id: string, step: number, length_steps = 1, velocity = 100): Note => ({
  row_id,
  step,
  length_steps,
  velocity,
});

export function patternWith(notes: Note[], overrides: Partial<Pattern> = {}): Pattern {
  return { ...emptyPattern(drums, 4), name: "Boom Bap", tempo_bpm: 92, notes, ...overrides };
}

// One loop and clip spanning the song, so tests that only care about notes can ignore clips.
export function trackWithNotes(track: Track, notes: Note[], measures: number): Track {
  return {
    ...track,
    loops: [{ id: `${track.id}-loop`, name: track.name, measures, notes }],
    clips: [{ id: `${track.id}-clip`, loop_id: `${track.id}-loop`, start_measure: 1, measures }],
  };
}
