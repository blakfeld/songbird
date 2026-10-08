import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import { STEPS_PER_MEASURE, SWING_RANGE, TEMPO_RANGE } from "../patternOps";
import { slugify } from "../midiFilename";
import { audioProblem, type AudioErrorKind } from "./audioValidation";
import { AUDIO_INSTRUMENT_ID } from "./audioTiming";
import { isValidLyric, MAX_LYRIC_CHARS, toplineLimitProblem } from "./toplineLimits";
import { migrateSong, validateClips } from "./migrate";
import { withBuiltIns } from "./sampler";
import { sectionProblem, type SectionErrorKind } from "./sectionValidation";
import { samplerProblem, type SamplerErrorKind } from "./samplerValidation";
import { soundProblem } from "./trackSound";
import {
  LYRICS_MAX_CHARS,
  SECTION_NAME_MAX,
  MAX_TRACKS,
  MEASURE_RANGE,
  PAN_RANGE,
  SONG_NAME_MAX,
  TONICS,
  TRACK_NAME_MAX,
  VOLUME_DB_RANGE,
  type Song,
} from "./types";

export const PROJECT_FORMAT = "songbird-song";
export const PROJECT_VERSION = 1;
// Large enough for the densest song the server accepts, small enough to refuse an unrelated file before reading it.
export const MAX_PROJECT_BYTES = 5 * 1024 * 1024;

// Fixture kinds are shared with the Rust validator so drift between the two shows up in tests;
// the rest only exist because the browser also checks the file envelope and untyped shapes.
export type ProjectErrorKind =
  | "format"
  | "json"
  | "size"
  | "newer_version"
  | "malformed"
  | "version"
  | "name"
  | "tempo"
  | "swing"
  | "steps_per_measure"
  | "measures"
  | "key"
  | "loop_region"
  | "chat"
  | "lyrics"
  | "lyric_chat"
  | "track_count"
  | "track_name"
  | "volume"
  | "pan"
  | "sound"
  | "unknown_instrument"
  | "loop_count"
  | "clip_count"
  | "duplicate_loop_id"
  | "loop_name"
  | "loop_length"
  | "loop_topline"
  | "loop_note_lyric"
  | "loop_note_row"
  | "loop_note_range"
  | "loop_note_overlap"
  | "duplicate_clip_id"
  | "clip_loop"
  | "clip_position"
  | "clip_length"
  | "clip_overlap"
  | "clip_outside_song"
  // A bundle's zip or audio is at fault, as opposed to the song inside it.
  | "bundle"
  | SectionErrorKind
  | AudioErrorKind
  | SamplerErrorKind;

// `release` is given by a bundle open, which pins the takes it stores until the caller has saved the song.
export type ProjectParse = { ok: Song; release?: () => void } | { error: string; kind: ProjectErrorKind };

interface Problem {
  kind: ProjectErrorKind;
  message: string;
}
const problem = (kind: ProjectErrorKind, message: string): Problem => ({ kind, message });

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const inRange = (v: number, r: { min: number; max: number }) => v >= r.min && v <= r.max;
// UTF-16 units, because the server, the name inputs' maxLength and validateClips all count that way;
// counting code points here would let through an emoji name the export then rejects.
const charLength = (s: string) => s.length;

export const projectFilename = (song: Pick<Song, "name">) =>
  `${slugify(song.name, "song")}.songbird.json`;

export function serializeProject(song: Song): string {
  return JSON.stringify({ format: PROJECT_FORMAT, version: PROJECT_VERSION, song }, null, 2);
}

function checkHeader(raw: Raw): Problem | null {
  if (raw.version !== 1 && raw.version !== 2)
    return problem("version", "its song has an unsupported version");
  if (typeof raw.id !== "string") return problem("malformed", "its song has no id");
  if (typeof raw.name !== "string" || charLength(raw.name) > SONG_NAME_MAX)
    return problem("name", `the song name must be at most ${SONG_NAME_MAX} characters`);
  if (!isInt(raw.tempo_bpm) || !inRange(raw.tempo_bpm, TEMPO_RANGE))
    return problem("tempo", `tempo must be a whole number from ${TEMPO_RANGE.min} to ${TEMPO_RANGE.max}`);
  if (!isNum(raw.swing) || !inRange(raw.swing, SWING_RANGE))
    return problem("swing", `swing must be from ${SWING_RANGE.min} to ${SWING_RANGE.max}`);
  const ts = raw.time_signature;
  if (ts !== "4/4" && ts !== "3/4" && ts !== "6/8")
    return problem("malformed", "the time signature is not supported");
  if (raw.steps_per_measure !== STEPS_PER_MEASURE[ts])
    return problem("steps_per_measure", `steps per measure must be ${STEPS_PER_MEASURE[ts]} for ${ts}`);
  if (!isInt(raw.measures) || !inRange(raw.measures, MEASURE_RANGE))
    return problem("measures", `the song must be ${MEASURE_RANGE.min} to ${MEASURE_RANGE.max} measures long`);
  // A stored key is corrected to C major on load, so a malformed one has to be refused here instead.
  if (raw.key !== undefined) {
    const k = raw.key;
    if (
      !isObject(k) ||
      !(TONICS as readonly unknown[]).includes(k.tonic) ||
      (k.mode !== "major" && k.mode !== "minor")
    )
      return problem("key", "the song key is not valid");
  }
  // Loading clamps the region, which would hide a corrupt one; an import should say so.
  if (raw.loop_region !== undefined && raw.loop_region !== null) {
    const l = raw.loop_region;
    if (!isObject(l) || typeof l.enabled !== "boolean")
      return problem("loop_region", "the loop region is not valid");
    if (l.region !== null) {
      const r = l.region;
      if (
        !isObject(r) ||
        !isInt(r.start_measure) ||
        !isInt(r.end_measure) ||
        r.start_measure < 1 ||
        r.end_measure < r.start_measure ||
        r.end_measure > MEASURE_RANGE.max
      )
        return problem(
          "loop_region",
          `the loop region must satisfy 1 <= start <= end <= ${MEASURE_RANGE.max}`,
        );
    }
  }
  if (raw.chat !== undefined) {
    const c = raw.chat;
    if (
      !Array.isArray(c) ||
      c.length > 20 ||
      c.some(
        (e) =>
          !isObject(e) ||
          (e.role !== "user" && e.role !== "assistant") ||
          typeof e.content !== "string" ||
          [...e.content].length > 4000 ||
          (e.track_id !== undefined && typeof e.track_id !== "string"),
      )
    )
      return problem("chat", "the saved chat must be at most 20 messages of 4000 characters");
  }
  if (raw.lyrics !== undefined) {
    // Code points rather than charLength's UTF-16 units, because the server counts lyrics that way.
    if (typeof raw.lyrics !== "string" || [...raw.lyrics].length > LYRICS_MAX_CHARS)
      return problem(
        "lyrics",
        `the lyrics must be text of at most ${LYRICS_MAX_CHARS.toLocaleString("en-US")} characters`,
      );
  }
  if (raw.lyric_chat !== undefined) {
    const found = lyricChatProblem(raw.lyric_chat);
    if (found) return found;
  }
  const sections = sectionProblem(raw.sections, raw.measures, { checkTotal: true });
  if (sections) return sections;
  return null;
}

const SUGGESTION_ACTIONS: readonly unknown[] = ["insert", "replace_selection", "replace_section"];
const isOffset = (v: unknown): v is number => isInt(v) && v >= 0;

// Rust refuses a wrong shape while parsing, before any limit is checked, so the shape pass runs over the whole
// conversation first and reports "malformed" the way the shared fixture expects.
function lyricChatShapeProblem(chat: unknown): Problem | null {
  const bad = (what: string) => problem("malformed", `the saved lyric chat has ${what}`);
  if (!Array.isArray(chat)) return bad("the wrong shape");
  for (const e of chat) {
    if (!isObject(e) || (e.role !== "user" && e.role !== "assistant") || typeof e.content !== "string")
      return bad("a message that is not valid");
    if (e.selection !== undefined) {
      const sel = e.selection;
      if (!isObject(sel) || !isOffset(sel.from) || !isOffset(sel.to) || typeof sel.text !== "string")
        return bad("a selection that is not valid");
    }
    if (e.suggestions === undefined) continue;
    if (!Array.isArray(e.suggestions)) return bad("suggestions that are not a list");
    for (const s of e.suggestions) {
      if (
        !isObject(s) ||
        typeof s.id !== "string" ||
        typeof s.label !== "string" ||
        typeof s.text !== "string" ||
        !SUGGESTION_ACTIONS.includes(s.action) ||
        (s.section_id !== undefined && typeof s.section_id !== "string") ||
        (s.section_name !== undefined && typeof s.section_name !== "string")
      )
        return bad("a suggestion that is not valid");
    }
  }
  return null;
}

// Mirrors Song::validate_lyric_chat. Text and label count code points like the server; the section name counts UTF-16
// units like every other name check, so an emoji name cannot pass here and fail on save.
function lyricChatProblem(chat: unknown): Problem | null {
  const shape = lyricChatShapeProblem(chat);
  if (shape) return shape;
  const entries = chat as Raw[];
  const tooLong = (message: string) => problem("lyric_chat", message);
  const points = (v: unknown, max: number) => [...(v as string)].length <= max;
  if (entries.length > 20) return tooLong("the saved lyric chat must be at most 20 messages");
  for (const e of entries) {
    if (!points(e.content, 4000)) return tooLong("lyric chat messages must be at most 4000 characters");
    const sel = e.selection as Raw | undefined;
    if (sel && !points(sel.text, LYRICS_MAX_CHARS))
      return tooLong("a lyric chat selection must be at most 20000 characters");
    const suggestions = (e.suggestions ?? []) as Raw[];
    if (suggestions.length > 5) return tooLong("a lyric chat message holds at most 5 suggestions");
    for (const s of suggestions) {
      if (!points(s.text, 2000) || !points(s.label, 80))
        return tooLong("lyric chat suggestions must be at most 2000 characters of text and 80 of label");
      if (s.section_name !== undefined && charLength(s.section_name as string) > SECTION_NAME_MAX)
        return tooLong(`lyric chat section names must be at most ${SECTION_NAME_MAX} characters`);
    }
  }
  return null;
}

const label = (t: Raw, i: number) => `Track ${i + 1} "${String(t.name)}"`;

function checkTracks(raw: Raw, instruments: InstrumentInfo[]): Problem | null {
  const { tracks } = raw;
  if (!Array.isArray(tracks) || tracks.length > MAX_TRACKS)
    return problem("track_count", `a song has at most ${MAX_TRACKS} tracks`);
  for (const [i, t] of tracks.entries()) {
    if (!isObject(t)) return problem("malformed", `track ${i + 1} is not valid`);
    if (typeof t.id !== "string" || typeof t.name !== "string" || typeof t.instrument !== "string")
      return problem("malformed", `track ${i + 1} is missing its id, name, or instrument`);
    if (typeof t.muted !== "boolean" || typeof t.soloed !== "boolean")
      return problem("malformed", `${label(t, i)} is missing its mute or solo state`);
    if (charLength(t.name) > TRACK_NAME_MAX)
      return problem(
        "track_name",
        `${label(t, i)}: the name must be at most ${TRACK_NAME_MAX} characters`,
      );
    if (!isNum(t.volume_db) || !inRange(t.volume_db, VOLUME_DB_RANGE))
      return problem(
        "volume",
        `${label(t, i)}: volume must be from ${VOLUME_DB_RANGE.min} to ${VOLUME_DB_RANGE.max} dB`,
      );
    if (!isNum(t.pan) || !inRange(t.pan, PAN_RANGE))
      return problem("pan", `${label(t, i)}: pan must be from -1 to 1`);
    const audio = t.instrument === AUDIO_INSTRUMENT_ID;
    if (!audio && !instruments.some((inst) => inst.id === t.instrument))
      return problem(
        "unknown_instrument",
        `${label(t, i)} uses the instrument "${t.instrument}", which Songbird does not offer`,
      );
    // Audio tracks take their sound checks from audioProblem, which knows tone is not allowed on them.
    if (t.sound !== undefined && !audio) {
      const drums = instruments.find((inst) => inst.id === t.instrument)?.kind === "drums";
      const reason = soundProblem(t.sound, drums);
      if (reason) return problem("sound", `${label(t, i)}: ${reason}`);
    }
    // Relabelled documents carry loops already; version 1 conversion would silently discard them.
    if (raw.version === 1 && ("loops" in t || "clips" in t))
      return problem("version", `${label(t, i)} has loops or clips but the song says version 1`);
  }
  return null;
}

// validateClips only returns prose, so the shared kind is recovered from it; loop notes need the
// loop itself to tell a bad span from an overlap.
function clipKind(raw: Raw, reason: string): ProjectErrorKind {
  const exact: Record<string, ProjectErrorKind> = {
    "too many loops": "loop_count",
    "too many clips": "clip_count",
    "duplicate loop id": "duplicate_loop_id",
    "loop name": "loop_name",
    "loop length": "loop_length",
    "duplicate clip id": "duplicate_clip_id",
    "clip position": "clip_position",
    "clip length": "clip_length",
    "overlapping clips": "clip_overlap",
    "clip beyond song end": "clip_outside_song",
  };
  if (reason in exact) return exact[reason];
  if (reason.endsWith("references a loop of another track")) return "clip_loop";
  const loopId = reason.match(/^notes of loop (.*)$/)?.[1];
  if (loopId !== undefined) {
    const loop = (raw.tracks as Raw[])
      .flatMap((t) => t.loops as Raw[])
      .find((l) => l.id === loopId);
    const total = (loop?.measures as number) * (raw.steps_per_measure as number);
    const notes = Array.isArray(loop?.notes) ? (loop.notes as Raw[]) : [];
    const badSpan = notes.some(
      (n) =>
        !isObject(n) ||
        !isInt(n.step) ||
        !isInt(n.length_steps) ||
        n.step < 0 ||
        n.length_steps < 1 ||
        n.step + n.length_steps > total,
    );
    return badSpan ? "loop_note_range" : "loop_note_overlap";
  }
  return "malformed";
}

// validateClips reports no location, but a prefix of the tracks fails exactly when the offending track is added.
function clipProblem(raw: Raw): Problem | null {
  const reason = validateClips(raw);
  if (reason === null) return null;
  const kind = clipKind(raw, reason);
  const tracks = raw.tracks as unknown[];
  for (let n = 1; n <= tracks.length; n++) {
    if (validateClips({ ...raw, tracks: tracks.slice(0, n) }) !== null) {
      return problem(kind, `${label(tracks[n - 1] as Raw, n - 1)}: ${reason}`);
    }
  }
  return problem(kind, reason);
}

const VOICES: readonly unknown[] = ["soprano", "alto", "tenor", "baritone"];

// Wrong shapes and unknown voices are "malformed" because the server rejects them
// while parsing, before any limit is checked.
function toplineProblem(topline: unknown): { kind: ProjectErrorKind; reason: string } | null {
  const malformed = { kind: "malformed" as const, reason: "its topline source is not valid" };
  const limit = (reason: string) => ({ kind: "loop_topline" as const, reason });
  if (!isObject(topline) || typeof topline.section_name !== "string" || !Array.isArray(topline.lines))
    return malformed;
  if (!VOICES.includes(topline.voice)) return malformed;
  const lines = topline.lines as unknown[];
  for (const line of lines) {
    if (!isObject(line) || typeof line.text !== "string" || !Array.isArray(line.syllables)) return malformed;
    for (const syl of line.syllables)
      if (!isObject(syl) || typeof syl.text !== "string" || typeof syl.stressed !== "boolean") return malformed;
  }
  const reason = toplineLimitProblem(topline.section_name, lines as { text: string; syllables: { text: string }[] }[]);
  if (reason) return limit(reason);
  return null;
}

function checkNotesAndClips(
  song: Song,
  declaredMeasures: number,
  instruments: InstrumentInfo[],
): Problem | null {
  for (const [i, t] of song.tracks.entries()) {
    const rows = new Set(instruments.find((inst) => inst.id === t.instrument)?.rows.map((r) => r.id));
    for (const loop of t.loops) {
      if (loop.topline !== undefined) {
        const found = toplineProblem(loop.topline);
        if (found) return problem(found.kind, `${label(t, i)}: loop "${loop.name}": ${found.reason}`);
      }
      for (const n of loop.notes) {
        if (!rows.has(n.row_id))
          return problem(
            "loop_note_row",
            `${label(t, i)}: loop "${loop.name}" has a note on "${n.row_id}", which ${t.instrument} does not have`,
          );
        if (n.lyric !== undefined && !isValidLyric(n.lyric))
          return problem(
            "loop_note_lyric",
            `${label(t, i)}: loop "${loop.name}" has a lyric on step ${n.step} that is not 1 to ${MAX_LYRIC_CHARS} characters without line breaks`,
          );
        if (!isInt(n.velocity) || n.velocity < 1 || n.velocity > 127)
          return problem(
            "loop_note_range",
            `${label(t, i)}: loop "${loop.name}" has a note velocity outside 1 to 127`,
          );
      }
    }
    // migrateSong stretches the stored length to fit the clips, which would hide a clip past the declared end.
    for (const c of t.clips) {
      if (c.start_measure + c.measures - 1 > declaredMeasures)
        return problem("clip_outside_song", `${label(t, i)}: a clip ends after the song's last measure`);
    }
  }
  return null;
}

const SIZE_MESSAGE = "That file is too large to be a Songbird project (limit 5 MB).";

export function parseProjectFile(text: string, registry: InstrumentInfo[]): ProjectParse {
  // The server never lists the sampler ids, but every document check accepts them.
  const instruments = withBuiltIns(registry);
  if (text.length > MAX_PROJECT_BYTES) return { error: SIZE_MESSAGE, kind: "size" };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { error: "That file isn't valid JSON, so it can't be a Songbird project.", kind: "json" };
  }
  if (!isObject(doc) || doc.format !== PROJECT_FORMAT)
    return { error: "That file isn't a Songbird project.", kind: "format" };
  if (!isInt(doc.version) || doc.version < 1)
    return { error: "That project file has an invalid version.", kind: "format" };
  if (doc.version > PROJECT_VERSION)
    return {
      error: "That project was made by a newer version of Songbird. Update Songbird to open it.",
      kind: "newer_version",
    };
  const raw = doc.song;
  if (!isObject(raw)) return { error: "That project file has no song.", kind: "malformed" };

  const early =
    checkHeader(raw) ?? checkTracks(raw, instruments) ??
    (raw.version === 2 ? (audioProblem(raw) ?? samplerProblem(raw) ?? clipProblem(raw)) : null);
  if (early) return { error: `That project can't be opened: ${early.message}.`, kind: early.kind };

  const song = migrateSong(raw);
  if (!song)
    return { error: "That project can't be opened: its song could not be converted.", kind: "malformed" };
  const late = checkNotesAndClips(song, raw.measures as number, instruments);
  if (late) return { error: `That project can't be opened: ${late.message}.`, kind: late.kind };
  return { ok: song };
}

export async function readProjectFile(file: File, instruments: InstrumentInfo[]): Promise<ProjectParse> {
  if (file.size > MAX_PROJECT_BYTES) return { error: SIZE_MESSAGE, kind: "size" };
  return parseProjectFile(await file.text(), instruments);
}
