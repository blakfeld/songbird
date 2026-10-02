import { clearMeasureRange, cutTrackAt } from "./song/clipOps";
import { insertAudio, isAudioFailure, removeAudio } from "./song/audioSplice";
import { IMPLICIT_SECTION_ID, implicitIndex, implicitSections } from "./song/implicitSections";
import { normalizeSong } from "./song/songOps";
import {
  MAX_CLIPS,
  MEASURE_RANGE,
  SECTION_MEASURE_RANGE,
  SECTION_NAME_MAX,
  SECTION_NOTES_MAX_CHARS,
  newId,
  type Clip,
  type Section,
  type SectionKind,
  type Song,
  type Track,
} from "./song/types";

export { IMPLICIT_SECTION_ID };
export const DEFAULT_SECTION_MEASURES = 8;

export const SECTION_KIND_LABELS: Record<SectionKind, string> = {
  intro: "Intro",
  verse: "Verse",
  "pre-chorus": "Pre-chorus",
  chorus: "Chorus",
  bridge: "Bridge",
  outro: "Outro",
  other: "Other",
};

export type SectionFailure =
  | "not-found"
  | "song-limit"
  | "length-range"
  | "last-section"
  | "loop-split"
  | "clip-limit"
  | "loop-limit";

// `track` names the lane that is full, because the user can only fix a limit if they know which one.
export type Refusal = { song: null; reason: SectionFailure; track?: string };
export type MeasureOpResult = { song: Song } | Refusal;
// `sectionId` is the section the caller should select afterwards, which for an implicit one is only known once it exists.
export type SectionOpResult = { song: Song; sectionId: string | null } | Refusal;

export interface SectionSpec {
  kind: SectionKind;
  name?: string;
  measures?: number;
}

export function describeRefusal(refusal: Refusal): string {
  const track = refusal.track ?? "A track";
  switch (refusal.reason) {
    case "song-limit":
      return `The song cannot exceed ${MEASURE_RANGE.max} measures.`;
    case "length-range":
      return `A section must be ${SECTION_MEASURE_RANGE.min} to ${SECTION_MEASURE_RANGE.max} measures long.`;
    case "last-section":
      return "A song needs at least one section.";
    case "clip-limit":
      return `${track} is full: it already has ${MAX_CLIPS} clips, the most a track can hold.`;
    case "loop-limit":
      return `${track} is full: it has too many loops for this edit. Delete an unused loop and try again.`;
    case "loop-split":
      return `${track} has a looping audio clip this edit would cut mid-loop. Turn its Loop off or trim it first.`;
    default:
      return "That section is no longer in the song.";
  }
}

const refuse = (reason: SectionFailure, track?: string): Refusal => ({ song: null, reason, track });
const isRefusal = (r: Song | Refusal): r is Refusal => "reason" in r;
const total = (sections: Section[]) => sections.reduce((n, s) => n + s.measures, 0);
const clipEnd = (c: Clip) => c.start_measure + c.measures;

// A view, never stored, so a song that was never sectioned stays byte-identical until its first edit.
export function sectionsOf(song: Song): Section[] {
  if (song.sections && song.sections.length > 0) return song.sections;
  return implicitSections(song.measures);
}

// Derived rather than stored, so sections can never gap or overlap.
export function sectionStarts(sections: Section[]): number[] {
  let start = 1;
  return sections.map((s) => {
    const at = start;
    start += s.measures;
    return at;
  });
}

// Every implicit chunk gets a real id together, so the document never holds a half-materialized song. The fresh id
// only exists in the document from here on, so callers re-resolve the id they were given.
function materialize(song: Song, id: string): { song: Song; id: string } {
  const index = implicitIndex(id);
  if ((song.sections?.length ?? 0) > 0 || index === null) return { song, id };
  const real = implicitSections(song.measures).map((s) => ({ ...s, id: newId() }));
  // An id past the last chunk names nothing, so it is passed through for the caller to report as not found.
  if (index >= real.length) return { song, id };
  return { song: { ...song, sections: real }, id: real[index].id };
}

function failedAt(reason: string, track: Track): Refusal {
  return refuse(
    reason === "loop-limit" ? "loop-limit" : reason === "clip-limit" ? "clip-limit" : "not-found",
    track.name,
  );
}

// Every cut for one edit is made in a single pass per track, so a clip cut at several points keeps its loop wherever it
// starts on a repeat of the original loop.
function cutAll(song: Song, points: number[]): Song | Refusal {
  const tracks: Track[] = [];
  for (const track of song.tracks) {
    const cut = cutTrackAt(song, track, points);
    if (typeof cut === "string") return failedAt(cut, track);
    tracks.push(cut);
  }
  return { ...song, tracks };
}

const withClips = (song: Song, fn: (t: Track) => Clip[]): Song => ({
  ...song,
  tracks: song.tracks.map((t) => {
    const clips = fn(t);
    return clips === t.clips ? t : { ...t, clips };
  }),
});

// Loops are never edited, so every clip outside the edited measures keeps sounding exactly as before.
// The result is deliberately not normalised: the caller is about to rewrite `sections`, and normalising against
// the old ones would stretch the last section to cover the clips that were just moved.
export function insertMeasures(
  song: Song,
  atMeasure: number,
  count: number,
  source?: { start: number; end: number },
): MeasureOpResult {
  const cut = cutAll(song, source ? [source.start, source.end + 1, atMeasure] : [atMeasure]);
  if (isRefusal(cut)) return cut;
  const current = cut;
  for (const t of current.tracks) {
    if (t.clips.some((c) => c.start_measure >= atMeasure && clipEnd(c) - 1 + count > MEASURE_RANGE.max))
      return refuse("song-limit", t.name);
  }
  const offset = source ? atMeasure - source.start : 0;
  let full: Track | undefined;
  const moved = withClips(current, (t) => {
    const copies = source
      ? t.clips
          .filter((c) => c.start_measure >= source.start && clipEnd(c) <= source.end + 1)
          .map((c) => ({ ...c, id: newId(), start_measure: c.start_measure + offset }))
      : [];
    const shifted = t.clips.map((c) =>
      c.start_measure >= atMeasure ? { ...c, start_measure: c.start_measure + count } : c,
    );
    if (copies.length === 0 && shifted.every((c, i) => c === t.clips[i])) return t.clips;
    const clips = [...shifted, ...copies].sort((a, b) => a.start_measure - b.start_measure);
    if (clips.length > MAX_CLIPS) full ??= t;
    return clips;
  });
  if (full) return refuse("clip-limit", (full as Track).name);
  const audio = insertAudio(moved, atMeasure, count, source);
  return isAudioFailure(audio) ? refuse(audio.reason, audio.track) : { song: { ...moved, tracks: audio } };
}

// Clips inside the range are cut straight out rather than split twice, which would bake loops nothing plays.
export function removeMeasures(song: Song, fromMeasure: number, count: number): MeasureOpResult {
  const last = fromMeasure + count - 1;
  let current = song;
  for (const track of song.tracks) {
    const result = clearMeasureRange(current, track.id, fromMeasure, last);
    if (result.song === null) return failedAt(result.reason, track);
    current = result.song;
  }
  const shifted = withClips(current, (t) =>
    t.clips.some((c) => c.start_measure > last)
      ? t.clips.map((c) => (c.start_measure > last ? { ...c, start_measure: c.start_measure - count } : c))
      : t.clips,
  );
  const audio = removeAudio(shifted, fromMeasure, count);
  return isAudioFailure(audio) ? refuse(audio.reason, audio.track) : { song: { ...shifted, tracks: audio } };
}

// Sections define the length, so the stored length is rewritten from them rather than left to the clips.
const withSections = (song: Song, sections: Section[]): Song =>
  normalizeSong({ ...song, sections, measures: total(sections) });

const fitName = (base: string, suffix: string) => `${base.slice(0, SECTION_NAME_MAX - suffix.length)}${suffix}`;

// Numbering starts at 2 because the unnumbered name is the first use, as with "Verse" then "Verse 2".
function uniqueName(sections: Section[], base: string, alwaysNumber = false): string {
  const taken = new Set(sections.map((s) => s.name));
  if (!alwaysNumber && !taken.has(base)) return base.slice(0, SECTION_NAME_MAX);
  for (let n = 2; ; n++) {
    const candidate = fitName(base, ` ${n}`);
    if (!taken.has(candidate)) return candidate;
  }
}

export const defaultSectionName = (song: Song, kind: SectionKind) =>
  uniqueName(sectionsOf(song), SECTION_KIND_LABELS[kind]);

const inRange = (measures: number) =>
  Number.isInteger(measures) && measures >= SECTION_MEASURE_RANGE.min && measures <= SECTION_MEASURE_RANGE.max;

type Anchor = { relativeTo: string; where: "before" | "after" };

function add(song: Song, spec: SectionSpec, anchor: Anchor | null): SectionOpResult {
  const measures = spec.measures ?? DEFAULT_SECTION_MEASURES;
  if (!inRange(measures)) return refuse("length-range");
  const prepared = materialize(song, anchor?.relativeTo ?? IMPLICIT_SECTION_ID);
  const sections = sectionsOf(prepared.song);
  const index = anchor ? sections.findIndex((s) => s.id === prepared.id) : sections.length - 1;
  if (index < 0) return refuse("not-found");
  if (total(sections) + measures > MEASURE_RANGE.max) return refuse("song-limit");

  const before = anchor?.where === "before";
  const position = before ? index : index + 1;
  const start = before ? sectionStarts(sections)[index] : sectionStarts(sections)[index] + sections[index].measures;
  const created: Section = {
    id: newId(),
    name: spec.name?.trim().slice(0, SECTION_NAME_MAX) || uniqueName(sections, SECTION_KIND_LABELS[spec.kind]),
    kind: spec.kind,
    measures,
    notes: "",
  };
  const inserted = insertMeasures(prepared.song, start, measures);
  if (inserted.song === null) return inserted;
  const next = [...sections.slice(0, position), created, ...sections.slice(position)];
  return { song: withSections(inserted.song, next), sectionId: created.id };
}

export const addSection = (song: Song, spec: SectionSpec): SectionOpResult => add(song, spec, null);

export const insertSection = (
  song: Song,
  spec: SectionSpec,
  relativeTo: string,
  where: "before" | "after",
): SectionOpResult => add(song, spec, { relativeTo, where });

function edit(song: Song, id: string, fn: (s: Section) => Section): SectionOpResult {
  const prepared = materialize(song, id);
  const sections = sectionsOf(prepared.song);
  const target = sections.find((s) => s.id === prepared.id);
  if (!target) return refuse("not-found");
  const changed = fn(target);
  // Returning the original song for a no-op lets the store skip an empty undo entry.
  if (changed === target) return { song, sectionId: id };
  return {
    song: withSections(prepared.song, sections.map((s) => (s === target ? changed : s))),
    sectionId: prepared.id,
  };
}

export function renameSection(song: Song, id: string, name: string): SectionOpResult {
  const next = name.trim().slice(0, SECTION_NAME_MAX);
  return edit(song, id, (s) => (!next || s.name === next ? s : { ...s, name: next }));
}

export function setSectionKind(song: Song, id: string, kind: SectionKind): SectionOpResult {
  return edit(song, id, (s) => (s.kind === kind ? s : { ...s, kind }));
}

// Code points, not UTF-16 units, because the server counts notes that way and a split pair would be rejected.
export const capSectionNotes = (text: string) => {
  const points = [...text];
  return points.length > SECTION_NOTES_MAX_CHARS ? points.slice(0, SECTION_NOTES_MAX_CHARS).join("") : text;
};

export function setSectionNotes(song: Song, id: string, text: string): SectionOpResult {
  const notes = capSectionNotes(text);
  return edit(song, id, (s) => (s.notes === notes ? s : { ...s, notes }));
}

export function resizeSection(song: Song, id: string, measures: number): SectionOpResult {
  if (!inRange(measures)) return refuse("length-range");
  const prepared = materialize(song, id);
  const sections = sectionsOf(prepared.song);
  const index = sections.findIndex((s) => s.id === prepared.id);
  if (index < 0) return refuse("not-found");
  const target = sections[index];
  const delta = measures - target.measures;
  if (delta === 0) return { song, sectionId: id };
  if (total(sections) + delta > MEASURE_RANGE.max) return refuse("song-limit");

  const start = sectionStarts(sections)[index];
  const moved =
    delta > 0
      ? insertMeasures(prepared.song, start + target.measures, delta)
      : removeMeasures(prepared.song, start + measures, -delta);
  if (moved.song === null) return moved;
  const next = sections.map((s) => (s === target ? { ...s, measures } : s));
  return { song: withSections(moved.song, next), sectionId: prepared.id };
}

export function duplicateSection(song: Song, id: string): SectionOpResult {
  const prepared = materialize(song, id);
  const sections = sectionsOf(prepared.song);
  const index = sections.findIndex((s) => s.id === prepared.id);
  if (index < 0) return refuse("not-found");
  const source = sections[index];
  if (total(sections) + source.measures > MEASURE_RANGE.max) return refuse("song-limit");

  const start = sectionStarts(sections)[index];
  const end = start + source.measures - 1;
  const inserted = insertMeasures(prepared.song, end + 1, source.measures, { start, end });
  if (inserted.song === null) return inserted;
  // A copy of "Chorus 2" is "Chorus 3", not "Chorus 2 2".
  const copy: Section = {
    ...source,
    id: newId(),
    name: uniqueName(sections, source.name.replace(/ \d+$/, "") || source.name, true),
  };
  const next = [...sections.slice(0, index + 1), copy, ...sections.slice(index + 1)];
  return { song: withSections(inserted.song, next), sectionId: copy.id };
}

// One call so the dialog's rename, kind and length changes land as a single undo step. Length goes first because
// it is the only part that can be refused, and it may materialize the implicit section the other two then address.
export function editSection(
  song: Song,
  id: string,
  patch: { name?: string; kind?: SectionKind; measures?: number },
): SectionOpResult {
  let current = song;
  let target = id;
  const steps: ((s: Song, id: string) => SectionOpResult)[] = [];
  if (patch.measures !== undefined) steps.push((s, i) => resizeSection(s, i, patch.measures!));
  if (patch.name !== undefined) steps.push((s, i) => renameSection(s, i, patch.name!));
  if (patch.kind !== undefined) steps.push((s, i) => setSectionKind(s, i, patch.kind!));
  for (const step of steps) {
    const result = step(current, target);
    if (result.song === null) return result;
    current = result.song;
    target = result.sectionId ?? target;
  }
  return { song: current, sectionId: target };
}

export function deleteSection(song: Song, id: string): SectionOpResult {
  if (sectionsOf(song).length <= 1) return refuse(sectionsOf(song).some((s) => s.id === id) ? "last-section" : "not-found");
  const prepared = materialize(song, id);
  const sections = sectionsOf(prepared.song);
  const index = sections.findIndex((s) => s.id === prepared.id);
  if (index < 0) return refuse("not-found");
  const target = sections[index];
  const removed = removeMeasures(prepared.song, sectionStarts(sections)[index], target.measures);
  if (removed.song === null) return removed;
  return { song: withSections(removed.song, sections.filter((s) => s !== target)), sectionId: null };
}
