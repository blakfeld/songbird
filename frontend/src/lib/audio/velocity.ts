// Linear in amplitude so velocity 127 is unity and lower values attenuate
// predictably.
export function velocityToGain(velocity: number): number {
  return Math.min(Math.max(velocity, 1), 127) / 127;
}
