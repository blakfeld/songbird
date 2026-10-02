import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Row } from "@/generated/Row";
import type { Track } from "@/generated/Track";
import { TONICS } from "./types";

export const SAMPLER_KEYS_ID = "sampler-keys";
export const SAMPLER_PADS_ID = "sampler-pads";

export type SamplerKind = "keys" | "pads";

export const PAD_COUNT = 16;
export const KEYS_RANGE = { low: 24, high: 96 } as const;
export const DEFAULT_ROOT_NOTE = 60;
export const PAD_GAIN_DB_RANGE = { min: -24, max: 12 } as const;
export const PAD_PITCH_RANGE = { min: -24, max: 24 } as const;
const PAD_BASE_NOTE = 36;

// A snappy release keeps short notes from smearing, and a sustain of 1 leaves the sample at its natural
// level until the key is let go.
export const SAMPLER_KEYS_ENVELOPE = { attack: 0.002, decay: 0.1, sustain: 1, release: 0.1 } as const;

export const samplerKindOf = (instrumentId: string): SamplerKind | null =>
  instrumentId === SAMPLER_KEYS_ID ? "keys" : instrumentId === SAMPLER_PADS_ID ? "pads" : null;

export const isSamplerId = (instrumentId: string) => samplerKindOf(instrumentId) !== null;

// Decided from the id, because the instrument lookup is empty while loading and the server validates by kind:
// pads take the drum knobs and keys the melodic ones.
export const usesDrumTone = (instrumentId: string) => instrumentId === "drums" || instrumentId === SAMPLER_PADS_ID;

export const padRowId = (index: number) => `pad-${index + 1}`;
export const padIndex = (rowId: string): number => {
  const m = /^pad-(\d+)$/.exec(rowId);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= PAD_COUNT && rowId === padRowId(n - 1) ? n - 1 : -1;
};

// Names match the melodic rows (C4 is MIDI 60), so a root note and a row id can be compared by eye.
export const noteName = (midi: number) => `${TONICS[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

const keysRows = (): Row[] => {
  const rows: Row[] = [];
  for (let midi = KEYS_RANGE.high; midi >= KEYS_RANGE.low; midi--)
    rows.push({ id: noteName(midi), name: noteName(midi), midi_note: midi });
  return rows;
};

const padRows = (): Row[] =>
  Array.from({ length: PAD_COUNT }, (_, i) => ({
    id: padRowId(i),
    name: `Pad ${i + 1}`,
    midi_note: PAD_BASE_NOTE + i,
  }));

// Built here rather than fetched because the server keeps the sampler ids out of its instrument list.
export const SAMPLER_KEYS_INFO: InstrumentInfo = {
  id: SAMPLER_KEYS_ID,
  name: "Sampler (keys)",
  kind: "melodic",
  midi_channel: 1,
  midi_program: null,
  range: { ...KEYS_RANGE },
  sustained: true,
  rows: keysRows(),
};

export const SAMPLER_PADS_INFO: InstrumentInfo = {
  id: SAMPLER_PADS_ID,
  name: "Sampler (pads)",
  kind: "drums",
  midi_channel: 10,
  midi_program: null,
  range: null,
  sustained: false,
  rows: padRows(),
};

export const SAMPLER_INFOS: readonly InstrumentInfo[] = [SAMPLER_KEYS_INFO, SAMPLER_PADS_INFO];

// Lets the Add Track menu keep the reserved ids out of its Drums and Melodic groups, where their kinds would list them.
export const BUILT_IN_IDS: ReadonlySet<string> = new Set(SAMPLER_INFOS.map((i) => i.id));

export const withBuiltIns = (instruments: InstrumentInfo[]): InstrumentInfo[] => [
  ...instruments.filter((i) => !BUILT_IN_IDS.has(i.id)),
  ...SAMPLER_INFOS,
];

// What keeps a sample's audio from being garbage collected when only a sampler uses it.
export function samplerSampleIds(track: Pick<Track, "sampler">): string[] {
  const ids: string[] = [];
  const { keys, pads } = track.sampler ?? {};
  if (keys?.sample_id) ids.push(keys.sample_id);
  for (const p of pads ?? []) ids.push(p.sample_id);
  return ids;
}
