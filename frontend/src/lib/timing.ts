export const STEPS_PER_QUARTER = 4;

// Must stay identical to the Rust `step_to_seconds` so playback and exported
// MIDI place every note at the same moment; exact (unrounded) because audio
// scheduling has no tick grid.
export function stepToSeconds(
  step: number,
  tempoBpm: number,
  swing: number,
): number {
  const sixteenth = 60 / tempoBpm / STEPS_PER_QUARTER;
  const swingOffset = step % 2 === 1 ? swing : 0;
  return (step + swingOffset) * sixteenth;
}
