"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { shareApi, type OwnerComment, type ShareApi } from "@/lib/share/shareApi";

interface Loaded {
  projectId: string;
  tick: number;
  comments: OwnerComment[];
  failed: boolean;
}

export interface ProjectComments {
  comments: OwnerComment[];
  unresolved: number;
  loading: boolean;
  failed: boolean;
  refresh: () => void;
  setResolved: (id: string, resolved: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

// Kept apart from the song store on purpose: comments belong to other people, so loading, resolving or deleting one
// must never create an undo step or change the document that autosave writes.
export function useProjectComments(projectId: string | null, api: ShareApi = shareApi): ProjectComments {
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api.listComments(projectId).then(
      (comments) => !cancelled && setLoaded({ projectId, tick, comments, failed: false }),
      // A refresh that fails keeps the last list rather than hiding comments the owner already saw.
      () => !cancelled && setLoaded((prev) => ({ projectId, tick, comments: prev?.projectId === projectId ? prev.comments : [], failed: true })),
    );
    return () => {
      cancelled = true;
    };
  }, [api, projectId, tick]);

  const current = loaded && loaded.projectId === projectId ? loaded : null;
  const comments = useMemo(() => current?.comments ?? [], [current]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const patch = useCallback(
    (change: (all: OwnerComment[]) => OwnerComment[]) =>
      setLoaded((prev) => (prev && prev.projectId === projectId ? { ...prev, comments: change(prev.comments) } : prev)),
    [projectId],
  );

  const setResolved = useCallback(
    async (id: string, resolved: boolean) => {
      if (!projectId) return;
      const updated = await api.setResolved(projectId, id, resolved);
      patch((all) => all.map((c) => (c.id === id ? updated : c)));
    },
    [api, projectId, patch],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!projectId) return;
      await api.removeComment(projectId, id);
      patch((all) => all.filter((c) => c.id !== id));
    },
    [api, projectId, patch],
  );

  return {
    comments,
    unresolved: comments.filter((c) => c.resolved_at === null).length,
    loading: projectId !== null && (current === null || current.tick !== tick),
    failed: current?.failed ?? false,
    refresh,
    setResolved,
    remove,
  };
}
