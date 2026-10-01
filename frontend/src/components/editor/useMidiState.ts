import { useSyncExternalStore } from "react";
import { ALL_INPUTS, getMidiAccess, type MidiAccess, type MidiSnapshot } from "@/lib/midi/access";

// Constant so server and first client render agree before the real access state is known.
const SERVER_SNAPSHOT: MidiSnapshot = {
  status: "prompt",
  inputs: [],
  selected: ALL_INPUTS,
  selectedConnected: true,
};

export function useMidiState(access?: MidiAccess): { access: MidiAccess; snapshot: MidiSnapshot } {
  // Resolved per render because the client singleton must not be created during SSR.
  const resolved = access ?? getMidiAccess();
  const snapshot = useSyncExternalStore(
    resolved.subscribeState,
    resolved.getSnapshot,
    () => SERVER_SNAPSHOT,
  );
  return { access: resolved, snapshot };
}
