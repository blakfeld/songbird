// Must match the backend rule exactly so the client-side counter never disagrees with server validation.
// Spreading iterates code points; string.length would count UTF-16 units and overcount emoji.
// JS trim strips exactly this set; the backend mirrors it explicitly because Rust's trim differs (U+0085, U+FEFF).
export function estimateTokens(prompt: string): number {
  const scalarValues = [...prompt.trim()].length;
  return Math.ceil(scalarValues / 4);
}
