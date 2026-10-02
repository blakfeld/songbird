import { PAD_COUNT, PAD_GAIN_DB_RANGE, PAD_PITCH_RANGE, padIndex, samplerKindOf } from "./sampler";

export type SamplerErrorKind =
  | "malformed"
  | "sampler_content"
  | "sampler_pad_count"
  | "sampler_pad_row"
  | "sampler_sample"
  | "sampler_range";

export interface SamplerProblem {
  kind: SamplerErrorKind;
  message: string;
}
const problem = (kind: SamplerErrorKind, message: string): SamplerProblem => ({ kind, message });

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const MAX_ROOT_NOTE = 127;

// Each rule's kind matches `validate_sampler_settings` in song.rs, and so does the order within one track. Across
// tracks and rules the two differ (this checks rule by rule, the server track by track), so a document with
// several faults may report a different one of them; a document with a single fault reports the same kind.
export function samplerProblem(raw: Raw): SamplerProblem | null {
  if (!Array.isArray(raw.tracks)) return null;
  const known = new Set(
    (Array.isArray(raw.samples) ? raw.samples : []).flatMap((s) => (isObject(s) && typeof s.id === "string" ? [s.id] : [])),
  );
  for (const [i, t] of raw.tracks.entries()) {
    if (!isObject(t)) continue;
    const label = `Track ${i + 1} "${String(t.name)}"`;
    const settings = t.sampler;
    // Null is not an absent field to the server's deserializer, so it is refused here as it is there.
    if (settings !== undefined && !isObject(settings))
      return problem("malformed", `${label}: sampler must be an object`);
    const keys = isObject(settings) ? settings.keys : undefined;
    const pads = isObject(settings) ? settings.pads : undefined;
    if (keys !== undefined && !isObject(keys))
      return problem("malformed", `${label}: sampler keys must be an object`);
    if (pads !== undefined && !Array.isArray(pads))
      return problem("malformed", `${label}: sampler pads must be a list`);
    const hasKeys = isObject(keys);
    const hasPads = Array.isArray(pads) && pads.length > 0;

    const kind = typeof t.instrument === "string" ? samplerKindOf(t.instrument) : null;
    if (kind === null) {
      if (hasKeys || hasPads)
        return problem("sampler_content", `${label}: sampler settings belong on sampler tracks only`);
      continue;
    }
    const missing = (what: string, id: string) =>
      problem("sampler_sample", `${label}: ${what} names sample \`${id}\`, which is not in samples`);

    if (kind === "keys") {
      if (hasPads) return problem("sampler_content", `${label}: a keys sampler has no pads`);
      if (!isObject(keys)) continue;
      const { sample_id: sampleId, root_note: root, one_shot: oneShot } = keys;
      if (sampleId !== undefined && sampleId !== null && typeof sampleId !== "string")
        return problem("malformed", `${label}: keys sample_id must be text or null`);
      if (root !== undefined && !Number.isInteger(root))
        return problem("malformed", `${label}: keys root_note must be a whole number`);
      if (oneShot !== undefined && typeof oneShot !== "boolean")
        return problem("malformed", `${label}: keys one_shot must be true or false`);
      if (typeof sampleId === "string" && !known.has(sampleId)) return missing("keys", sampleId);
      if (typeof root === "number" && (root < 0 || root > MAX_ROOT_NOTE))
        return problem("sampler_range", `${label}: root_note must be 0-${MAX_ROOT_NOTE}, got ${root}`);
      continue;
    }

    if (hasKeys) return problem("sampler_content", `${label}: a pads sampler has no keys settings`);
    if (!Array.isArray(pads)) continue;
    if (pads.length > PAD_COUNT)
      return problem("sampler_pad_count", `${label}: at most ${PAD_COUNT} pads, got ${pads.length}`);
    const seen = new Set<string>();
    for (const pad of pads) {
      if (!isObject(pad) || typeof pad.row_id !== "string" || typeof pad.sample_id !== "string")
        return problem("malformed", `${label}: a pad is missing its row_id or sample_id`);
      const gain = pad.gain_db === undefined ? 0 : pad.gain_db;
      const pitch = pad.pitch_semitones === undefined ? 0 : pad.pitch_semitones;
      if (!isNum(gain) || !Number.isInteger(pitch))
        return problem("malformed", `${label}: pad \`${pad.row_id}\` has an invalid gain or pitch`);
      if (padIndex(pad.row_id) < 0)
        return problem("sampler_pad_row", `${label}: pad row \`${pad.row_id}\` is not one of pad-1 to pad-${PAD_COUNT}`);
      if (seen.has(pad.row_id))
        return problem("sampler_pad_row", `${label}: pad row \`${pad.row_id}\` is assigned more than once`);
      seen.add(pad.row_id);
      if (!known.has(pad.sample_id)) return missing(`pad \`${pad.row_id}\``, pad.sample_id);
      if (gain < PAD_GAIN_DB_RANGE.min || gain > PAD_GAIN_DB_RANGE.max)
        return problem(
          "sampler_range",
          `${label}: pad \`${pad.row_id}\` gain_db must be ${PAD_GAIN_DB_RANGE.min}-${PAD_GAIN_DB_RANGE.max}, got ${gain}`,
        );
      if (Math.abs(pitch as number) > PAD_PITCH_RANGE.max)
        return problem(
          "sampler_range",
          `${label}: pad \`${pad.row_id}\` pitch_semitones must be ${PAD_PITCH_RANGE.min} to ${PAD_PITCH_RANGE.max}, got ${pitch}`,
        );
    }
  }
  return null;
}
