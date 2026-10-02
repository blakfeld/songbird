"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { hintClass, inputClass } from "@/components/ui/classes";
import { ApiError } from "@/lib/api";
import { login, me } from "@/lib/auth/client";
import { navigateTo } from "@/lib/auth/navigation";
import { safeReturnTarget } from "@/lib/auth/returnTarget";

type LoginError = "invalid" | "throttled" | "busy" | "other";

const COPY: Record<LoginError, string> = {
  invalid: "Email or password is incorrect",
  throttled: "Too many sign-in attempts. Try again in a few minutes.",
  busy: "Songbird is busy right now. Try again in a moment.",
  other: "Couldn't sign in. Check your connection and try again.",
};

function classify(e: unknown): LoginError {
  if (e instanceof ApiError) {
    if (e.code === "invalid_credentials") return "invalid";
    if (e.code === "too_many_requests") return "throttled";
    if (e.code === "server_busy") return "busy";
  }
  return "other";
}

export function LoginForm() {
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A 401 here only means "not signed in", so it must not run the app-wide sign-out.
    me({ signOutOnUnauthenticated: false }).then(
      () => {
        if (!cancelled) navigateTo("/");
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    // Cleared first so a repeated failure re-announces through the alert.
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      const kind = classify(err);
      setError(kind);
      setSubmitting(false);
      if (kind === "invalid") {
        setPassword("");
        passwordRef.current?.focus();
      }
      return;
    }
    // Left in the submitting state until the page is replaced, so a second click cannot start another login.
    const next = new URLSearchParams(window.location.search).get("next");
    navigateTo(safeReturnTarget(next, window.location.origin));
  }

  const invalid = error === "invalid";
  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-4 py-12 text-zinc-900 sm:px-6 dark:bg-black dark:text-zinc-50">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 sm:p-8 dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Songbird</p>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <form onSubmit={onSubmit} aria-busy={submitting} className="mt-6 flex flex-col gap-4">
          <Field label="Email" htmlFor={emailId}>
            <input
              id={emailId}
              name="email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              spellCheck={false}
              autoCapitalize="none"
              inputMode="email"
              readOnly={submitting}
              aria-invalid={invalid}
              aria-describedby={error ? errorId : undefined}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${inputClass} w-full`}
            />
          </Field>
          <Field label="Password" htmlFor={passwordId}>
            <input
              ref={passwordRef}
              id={passwordId}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              readOnly={submitting}
              aria-invalid={invalid}
              aria-describedby={error ? errorId : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${inputClass} w-full`}
            />
          </Field>
          {error && (
            <div id={errorId}>
              <ErrorAlert message={COPY[error]} />
            </div>
          )}
          <Button type="submit" variant="primary" disabled={submitting} className="w-full">
            {submitting && <Spinner />}
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className={`${hintClass} mt-6`}>
          Accounts are set up by your Songbird administrator. Ask them for access or a new password.
        </p>
      </div>
    </main>
  );
}
