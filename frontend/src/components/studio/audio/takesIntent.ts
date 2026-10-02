// The clip menu cannot own a text field or the dock's focus, so it asks the Takes list for them. An intent that
// arrives before the list is mounted, because the dock was closed, waits for it instead of being lost.
export type TakesIntent = { kind: "rename"; sampleId: string } | { kind: "heading" };

let listener: ((intent: TakesIntent) => void) | null = null;
let pending: TakesIntent | null = null;

export function requestTakes(intent: TakesIntent) {
  if (listener) listener(intent);
  else pending = intent;
}

export function listenForTakes(cb: (intent: TakesIntent) => void): () => void {
  listener = cb;
  if (pending) {
    const waiting = pending;
    pending = null;
    cb(waiting);
  }
  return () => {
    if (listener === cb) listener = null;
  };
}
