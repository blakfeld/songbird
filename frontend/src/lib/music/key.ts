import type { Row } from "@/generated/Row";
import { TONICS, type SongKey } from "../song/types";

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
// Natural minor, so the relative major's highlight is identical to the minor's.
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

export const tonicPitchClass = (key: SongKey) => TONICS.indexOf(key.tonic);

export function scalePitchClasses(key: SongKey): number[] {
  const root = tonicPitchClass(key);
  return (key.mode === "major" ? MAJOR_STEPS : MINOR_STEPS).map((i) => (root + i) % 12);
}

export const rowPitchClass = (row: Pick<Row, "midi_note">) => row.midi_note % 12;

export type RowTint = "none" | "scale" | "tonic";

export interface KeyHighlight {
  scale: ReadonlySet<number>;
  tonic: number;
  // Shown on the tonic marker and read out for keyboard keys, so the tonic is never colour-only.
  tonicLabel: string;
  keyName: string;
}

export function keyHighlight(key: SongKey): KeyHighlight {
  const tonicLabel = key.tonic.replace("#", "♯");
  return {
    scale: new Set(scalePitchClasses(key)),
    tonic: tonicPitchClass(key),
    tonicLabel,
    keyName: `${tonicLabel} ${key.mode}`,
  };
}

export function rowTint(highlight: KeyHighlight, row: Pick<Row, "midi_note">): RowTint {
  const pc = rowPitchClass(row);
  if (pc === highlight.tonic) return "tonic";
  return highlight.scale.has(pc) ? "scale" : "none";
}
