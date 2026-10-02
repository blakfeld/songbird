"use client";

import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { PlaybackEngine } from "@/lib/audio/engine";
import type { InputOwner, InputEnvironment, TrackInputView } from "@/lib/audio/recorder/trackInput";
import type { SongStore } from "@/lib/song/songStore";

export interface AudioInputContextValue {
  owner: InputOwner;
  engine: Pick<PlaybackEngine, "prepareInput" | "setMonitoring">;
  store: SongStore;
  announce: (message: string) => void;
  // A refused Record asks the track's popover to open, so the user lands on the explanation.
  popoverRequest: { trackId: string; nonce: number } | null;
}

// Optional so a header rendered on its own, as in unit tests of other features, simply has no recording controls.
const AudioInputContext = createContext<AudioInputContextValue | null>(null);
export const AudioInputProvider = AudioInputContext.Provider;
export const useAudioInput = () => useContext(AudioInputContext);

export function useInputEnvironment(owner: InputOwner): InputEnvironment {
  return useSyncExternalStore(owner.subscribeEnv, owner.getEnv, owner.getEnv);
}

export function useTrackInputView(owner: InputOwner, trackId: string): TrackInputView {
  return useSyncExternalStore(
    (cb) => owner.subscribeView(trackId, cb),
    () => owner.getView(trackId),
    () => owner.getView(trackId),
  );
}

// Reads the browser's permission once and again whenever it changes, so the page never needs a reload after the
// user flips the setting in the address bar.
export function useWatchInputEnvironment(owner: InputOwner) {
  useEffect(() => {
    let alive = true;
    let status: PermissionStatus | null = null;
    void owner.refresh();
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((s) => {
        if (!alive) return;
        status = s;
        s.onchange = () => void owner.refresh();
      })
      .catch(() => undefined);
    // Plugging a device in or out changes what can be recorded without any permission change.
    const onDevices = () => void owner.refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDevices);
    return () => {
      alive = false;
      if (status) status.onchange = null;
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDevices);
    };
  }, [owner]);
}
