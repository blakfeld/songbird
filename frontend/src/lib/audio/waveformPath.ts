import { OVERVIEW_FRAMES_PER_BUCKET } from "./sampleAnalysis";

const cache = new Map<string, string>();
const CACHE_LIMIT = 200;

// x is in frames of the slice and y runs from -1 to 1, so the SVG can scale it by viewBox alone.
// Memoised by the caller's key because the same slice is drawn by the lane, the dock and the library.
export function peaksPath(
  overview: Float32Array,
  offsetSamples: number,
  sliceSamples: number,
  key?: string,
  maxColumns = 1024,
): string {
  const memo = key === undefined ? null : `${key}:${offsetSamples}:${sliceSamples}:${maxColumns}`;
  if (memo !== null) {
    const hit = cache.get(memo);
    if (hit !== undefined) return hit;
  }
  const first = Math.floor(offsetSamples / OVERVIEW_FRAMES_PER_BUCKET);
  const last = Math.max(first, Math.ceil((offsetSamples + sliceSamples) / OVERVIEW_FRAMES_PER_BUCKET) - 1);
  const buckets = Math.min(last, overview.length / 2 - 1) - first + 1;
  if (buckets <= 0 || sliceSamples <= 0) return "";
  const columns = Math.min(maxColumns, buckets);
  const top: string[] = [];
  const bottom: string[] = [];
  for (let c = 0; c < columns; c++) {
    const from = first + Math.floor((c * buckets) / columns);
    const to = first + Math.max(Math.floor(((c + 1) * buckets) / columns), Math.floor((c * buckets) / columns) + 1);
    let min = Infinity;
    let max = -Infinity;
    for (let b = from; b < to; b++) {
      if (overview[b * 2] < min) min = overview[b * 2];
      if (overview[b * 2 + 1] > max) max = overview[b * 2 + 1];
    }
    const x0 = (c * sliceSamples) / columns;
    const x1 = ((c + 1) * sliceSamples) / columns;
    // A silent column keeps a hairline so the waveform never disappears entirely.
    const lo = Math.min(min, -0.005);
    const hi = Math.max(max, 0.005);
    top.push(`${x0.toFixed(1)} ${(-hi).toFixed(3)}L${x1.toFixed(1)} ${(-hi).toFixed(3)}`);
    bottom.push(`${x1.toFixed(1)} ${(-lo).toFixed(3)}L${x0.toFixed(1)} ${(-lo).toFixed(3)}`);
  }
  const d = `M${top.join("L")}L${bottom.reverse().join("L")}Z`;
  if (memo !== null) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(memo, d);
  }
  return d;
}
