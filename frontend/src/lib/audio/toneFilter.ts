import type { ToneControls } from "./types";

type ToneModule = typeof import("tone");
export type ToneFilter = InstanceType<ToneModule["Filter"]>;

// Parameter changes shorter than a few ms click; this is still well inside the 50 ms live-edit budget.
export const FILTER_RAMP_SECONDS = 0.02;

// Above the audible band, so a filter that exists only to be controllable leaves the sound unchanged.
export const OPEN_CUTOFF_HZ = 20000;

// Presets' filters used Tone's default Q, so resonance 0 must land on it to keep their sound.
const BASE_Q = 1;
// A lowpass biquad's Q is in dB: it is the height of the peak at the cutoff. Mapping resonance
// linearly onto it makes the knob track the loudness of the peak.
const PEAK_DB_AT_FULL = 12;

// Tone cascades one biquad per 12 dB/oct and gives each the same Q, so the peaks add; dividing the
// target between the stages keeps the full-resonance peak at +12 dB whatever the rolloff, so the knob
// cannot get piercing or push a track into clipping.
const stages = (rolloff: number) => Math.abs(rolloff) / 12;

export type FilterRolloff = -12 | -24 | -48 | -96;

export const resonanceToQ = (resonance: number, rolloff: number = DEFAULT_ROLLOFF) =>
  BASE_Q + (PEAK_DB_AT_FULL / stages(rolloff) - BASE_Q) * Math.min(1, Math.max(0, resonance));

// A preset may keep a gentler slope because an absent sound must sound exactly as it did before filters were controllable.
export const DEFAULT_ROLLOFF: FilterRolloff = -24;

export function createToneFilter(
  tone: ToneModule,
  cutoffHz: number,
  resonance: number | undefined,
  rolloff: FilterRolloff = DEFAULT_ROLLOFF,
): ToneFilter {
  return new tone.Filter({
    type: "lowpass",
    rolloff,
    frequency: cutoffHz,
    Q: resonanceToQ(resonance ?? 0, rolloff),
  });
}

export function rampToneFilter(
  filter: ToneFilter,
  controls: ToneControls,
  defaultCutoffHz: number,
  rolloff: FilterRolloff = DEFAULT_ROLLOFF,
) {
  // Exponential because pitch perception is logarithmic; a linear ramp would sweep audibly late.
  filter.frequency.exponentialRampTo(
    controls.filterCutoffHz ?? defaultCutoffHz,
    FILTER_RAMP_SECONDS,
  );
  filter.Q.rampTo(resonanceToQ(controls.filterResonance ?? 0, rolloff), FILTER_RAMP_SECONDS);
}

// Filters are only built once something asks to shape them, so a track with no override has exactly the graph it had before.
export const wantsFilter = (controls?: ToneControls) =>
  controls?.filterCutoffHz !== undefined || controls?.filterResonance !== undefined;
