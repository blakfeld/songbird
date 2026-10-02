"use client";

import { useCallback, useState } from "react";
import { useAiKeys } from "@/components/ai/AiKeysProvider";
import { ApiError, generateTrack } from "@/lib/api";
import { describeError, isKeyErrorCode, type DescribedError } from "@/lib/aiKeys/keyError";
import type { SongStore } from "@/lib/song/songStore";
import type { GenerateRequest } from "./TrackGenerateDialog";

interface DialogState {
  trackId: string;
  prompt: string;
  error: DescribedError | null;
}

export function useTrackGeneration(
  store: SongStore,
  announce: (message: string) => void,
  guardEdit: (edit: () => void) => void,
) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const { refresh } = useAiKeys();

  const open = useCallback((trackId: string) => setDialog({ trackId, prompt: "", error: null }), []);
  const close = useCallback(() => setDialog(null), []);

  const submit = useCallback(
    async (trackId: string, { prompt, range }: GenerateRequest) => {
      // Snapshotted so edits made to other tracks while waiting are neither sent nor overwritten by the result.
      const snapshot = store.getState().song;
      const name = snapshot?.tracks.find((t) => t.id === trackId)?.name ?? "The track";
      if (!snapshot || !store.getState().beginGenerating(trackId)) return;
      const { loadEpoch: epoch, generationToken: token } = store.getState();
      announce(`Generating ${name}…`);
      let failure = null as DescribedError | null;
      try {
        const result = await generateTrack({
          song: snapshot,
          track_id: trackId,
          prompt,
          ...(range && { range }),
        });
        // The response belongs to the song it was requested for; a different one now open must not receive it.
        if (store.getState().loadEpoch !== epoch) return;
        guardEdit(() => {
          const refusal = store.getState().applyGeneratedRange(trackId, result.range, result.notes);
          if (refusal !== null) failure = { message: refusal };
        });
        if (failure === null) announce(`Generated a new part for ${name}. Undo to restore the previous one.`);
      } catch (err) {
        if (store.getState().loadEpoch !== epoch) return;
        // The gate must reflect a key that was removed or revoked elsewhere.
        if (err instanceof ApiError && isKeyErrorCode(err.code)) void refresh();
        const { message, action } = describeError(err);
        failure = { message: `${message} ${name} is unchanged.`, action };
      } finally {
        store.getState().endGenerating(token);
      }
      // The dialog reopens with the prompt intact so a failed attempt can be adjusted rather than retyped.
      if (failure !== null) setDialog({ trackId, prompt, error: failure });
    },
    [store, announce, guardEdit, refresh],
  );

  return { dialog, open, close, submit };
}
