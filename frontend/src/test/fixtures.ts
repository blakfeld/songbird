import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Note } from "@/generated/Note";
import type { Pattern } from "@/generated/Pattern";
import { emptyPattern } from "@/lib/patternOps";

export const drums: InstrumentInfo = {
  id: "drums",
  name: "Drums",
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
