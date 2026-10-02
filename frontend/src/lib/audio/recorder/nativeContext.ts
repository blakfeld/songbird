// The one place that reaches under Tone. Tone's context wraps standardized-audio-context, whose worklet loader builds a
// blob URL that the Content Security Policy rejects, so the recorder loads its module on the native context, from the
// app's own origin. The wrapper keeps the native context in `_nativeContext`, which is not public API, so this fails
// loudly rather than quietly recording nothing if a library update moves it.
export function nativeContextOf(ctx: { rawContext?: unknown }): AudioContext {
  const native = (ctx.rawContext as { _nativeContext?: unknown } | undefined)?._nativeContext;
  if (!native || typeof (native as AudioContext).createGain !== "function") {
    throw new Error("The audio library no longer exposes its native context, so recording cannot start.");
  }
  return native as AudioContext;
}
