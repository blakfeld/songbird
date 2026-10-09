"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { setCurrentUserId } from "@/lib/auth/currentUser";
import { me, type AuthUser } from "@/lib/auth/client";

interface Auth {
  user: AuthUser | null;
}

const AuthContext = createContext<Auth>({ user: null });

export const useAuth = () => useContext(AuthContext);

type State = { status: "loading" } | { status: "error" } | { status: "ready"; user: AuthUser };

// Children render only once `me` has resolved, so nothing that keys storage by user (the pattern
// stores, the last-opened song) can run first and read or write under the wrong user.
export function AuthProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // A share link page is for visitors with no account, and checking a session there would make a stale cookie sign the visitor out of a page that never needed one.
  const skipsSession = pathname === "/login" || pathname?.startsWith("/listen/") === true;
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (skipsSession) return;
    let cancelled = false;
    me().then(
      (user) => {
        // Set before the state change so children's first render already sees the user.
        setCurrentUserId(user.id);
        if (!cancelled) setState({ status: "ready", user });
      },
      () => {
        // A 401 has already started the sign-out navigation; anything else is worth a retry.
        if (!cancelled) setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [skipsSession, attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((a) => a + 1);
  }, []);

  if (skipsSession) return <AuthContext.Provider value={{ user: null }}>{children}</AuthContext.Provider>;

  if (state.status === "loading") {
    return (
      <main className="flex flex-1 items-center justify-center bg-zinc-50 p-6 text-zinc-900 dark:bg-black dark:text-zinc-50">
        <p role="status">Loading…</p>
      </main>
    );
  }
  if (state.status === "error") {
    return (
      <main className="flex flex-1 items-center justify-center bg-zinc-50 p-6 dark:bg-black">
        <ErrorAlert message="Couldn't check your sign-in. Check your connection and try again." onRetry={retry} />
      </main>
    );
  }
  return <AuthContext.Provider value={{ user: state.user }}>{children}</AuthContext.Provider>;
}
