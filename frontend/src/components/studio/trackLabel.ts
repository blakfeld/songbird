import type { InstrumentInfo } from "@/generated/InstrumentInfo";

// The instrument is named so the user can see what the assistant chose; it is dropped when the track name already says it.
// A step shown while the instrument list may still be loading passes `idFallback`, because naming the instrument matters
// more there than its spelling; finished messages drop it instead so they read the same once the list arrives.
export function trackLabel(
  name: string,
  instrumentId: string,
  instruments: readonly InstrumentInfo[] | null,
  { idFallback = false }: { idFallback?: boolean } = {},
): string {
  const instrument =
    instruments?.find((i) => i.id === instrumentId)?.name ?? (instruments === null && idFallback ? instrumentId : undefined);
  return instrument && instrument !== name ? `${name} (${instrument})` : name;
}
