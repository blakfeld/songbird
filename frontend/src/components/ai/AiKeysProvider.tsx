"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { getAiKeys, ApiError } from "@/lib/api";
import type { AiKeyEntry, AiKeySummary, AiProvider } from "@/lib/aiKeys/types";

// "unavailable" is the server saying key management is off; unlike "error" it is permanent, so no retry is offered.
export type AiKeysStatus = "loading" | "ready" | "unavailable" | "error";

export interface AiKeys {
  status: AiKeysStatus;
  keysRequired: boolean;
  activeProvider: AiProvider | null;
  keys: AiKeyEntry[];
  refresh: () => Promise<void>;
  // The settings page already holds the fresh summary a mutation returned, so it needn't fetch again.
  apply: (summary: AiKeySummary) => void;
}

const NO_KEYS: AiKeyEntry[] = [];

// Outside a provider (the login page, isolated component tests) nothing is gated.
const AiKeysContext = createContext<AiKeys>({
  status: "ready",
  keysRequired: false,
  activeProvider: null,
  keys: NO_KEYS,
  refresh: async () => {},
  apply: () => {},
});

export const useAiKeys = () => useContext(AiKeysContext);

type State = { status: "loading" | "unavailable" | "error" } | { status: "ready"; summary: AiKeySummary };

export function AiKeysProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState<State>({ status: "loading" });
  // Only the latest request may write, so a slow earlier response cannot undo a newer one.
  const latest = useRef(0);

  const invalidate = useCallback(() => {
    latest.current++;
  }, []);

  const settle = useCallback((id: number, load: Promise<AiKeySummary>) => {
    return load.then(
      (summary) => {
        if (latest.current === id) setState({ status: "ready", summary });
      },
      (err: unknown) => {
        if (latest.current !== id) return;
        if (err instanceof ApiError && err.code === "api_keys_unavailable") setState({ status: "unavailable" });
        // A failed background refresh keeps the last known summary rather than flipping gates on a network blip.
        else setState((prev) => (prev.status === "ready" ? prev : { status: "error" }));
      },
    );
  }, []);

  const refresh = useCallback(() => settle(++latest.current, getAiKeys()), [settle]);

  useEffect(() => {
    if (userId === null) return;
    void settle(++latest.current, getAiKeys());
    return invalidate;
  }, [userId, settle, invalidate]);

  const apply = useCallback((summary: AiKeySummary) => {
    invalidate();
    setState({ status: "ready", summary });
  }, [invalidate]);

  const value = useMemo<AiKeys>(() => {
    const summary = state.status === "ready" ? state.summary : null;
    return {
      status: state.status,
      keysRequired: summary?.keys_required ?? false,
      activeProvider: summary?.active_provider ?? null,
      keys: summary?.keys ?? NO_KEYS,
      refresh,
      apply,
    };
  }, [state, refresh, apply]);

  return <AiKeysContext.Provider value={value}>{children}</AiKeysContext.Provider>;
}
