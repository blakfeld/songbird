"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useAiKeys } from "@/components/ai/AiKeysProvider";
import { AccountMenu } from "@/components/auth/AccountMenu";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { focusRing, hintClass } from "@/components/ui/classes";
import { PROVIDER_LABEL } from "@/lib/aiKeys/keyError";
import type { AiKeyEntry, AiKeySummary, AiProvider } from "@/lib/aiKeys/types";
import { safeReturnTarget } from "@/lib/auth/returnTarget";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { KeyForm } from "./KeyForm";
import { ProviderRadioGroup } from "./ProviderRadioGroup";
import { RemoveKeyDialog } from "./RemoveKeyDialog";
import { spell } from "./aiKeyMessages";

const PROVIDERS: AiProvider[] = ["anthropic", "openai"];

const BACK_LABEL: Record<string, string> = {
  "/studio": "Studio",
  "/drum-machine": "Drum Machine",
};

const noticeClass =
  "rounded-lg border border-amber-600/40 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200";

// Gate notices and error links pass the page the user came from, so they can go straight back after saving.
function readBackLink(): { href: string; label: string } | null {
  if (typeof window === "undefined") return null;
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next) return null;
  const href = safeReturnTarget(next, window.location.origin);
  if (href === "/") return null;
  const path = href.split(/[?#]/)[0];
  const place = BACK_LABEL[path] ?? (path.startsWith("/instruments/") ? "pattern editor" : null);
  return { href, label: place ? `← Back to ${place}` : "← Back" };
}

export function AiKeysPage() {
  const { status, keysRequired, activeProvider, keys, refresh, apply } = useAiKeys();
  const [back] = useState(readBackLink);
  const [editing, setEditing] = useState<AiProvider | null>(null);
  const [removing, setRemoving] = useState<AiProvider | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const idPrefix = useId();
  // Controls that had focus are gone after a save or removal, so focus is restored once the new ones render.
  const pendingFocus = useRef<string | null>(null);
  const opener = useRef<string | null>(null);

  useEffect(() => {
    if (pendingFocus.current) {
      document.getElementById(pendingFocus.current)?.focus();
      pendingFocus.current = null;
    }
  });

  const entryFor = (provider: AiProvider): AiKeyEntry | undefined => keys.find((k) => k.provider === provider);
  const buttonId = (provider: AiProvider, kind: "set" | "replace") => `${idPrefix}-${provider}-${kind}`;

  function saved(provider: AiProvider, replaced: boolean, summary: AiKeySummary) {
    const last4 = summary.keys.find((k) => k.provider === provider)?.last4 ?? "";
    const name = PROVIDER_LABEL[provider];
    const madeActive = activeProvider === null && summary.active_provider === provider;
    setAnnouncement(
      `${name} key ${replaced ? "replaced" : "saved"}, ending in ${spell(last4)}.${madeActive ? ` ${name} is now used for AI features.` : ""}`,
    );
    pendingFocus.current = buttonId(provider, "replace");
    apply(summary);
    setEditing(null);
  }

  function removed(provider: AiProvider, summary: AiKeySummary) {
    const switched = activeProvider === provider && summary.active_provider !== null;
    setAnnouncement(
      `${PROVIDER_LABEL[provider]} key removed.${switched ? ` ${PROVIDER_LABEL[summary.active_provider!]} is now used for AI features.` : ""}`,
    );
    pendingFocus.current = buttonId(provider, "set");
    apply(summary);
    setRemoving(null);
  }

  function consequenceOfRemoving(provider: AiProvider): string {
    const other = PROVIDERS.find((p) => p !== provider)!;
    if (activeProvider === provider && entryFor(other)) {
      return `Songbird will switch to ${PROVIDER_LABEL[other]} for AI features.`;
    }
    if (keys.length === 1 && keysRequired) {
      return "AI features (Generate, track generation, and the assistant) will be turned off until you add a key.";
    }
    return "You can add it again at any time.";
  }

  const bothKeys = keys.length === 2;

  return (
    <main className="mx-auto flex w-full max-w-2xl min-w-0 flex-1 flex-col gap-6 bg-zinc-50 px-4 py-6 text-zinc-900 sm:px-6 sm:py-8 dark:bg-black dark:text-zinc-50">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <nav aria-label="Breadcrumb" className="text-sm text-zinc-600 dark:text-zinc-400">
            <Link href="/" className={`rounded-sm underline-offset-2 hover:underline ${focusRing}`}>
              Songbird
            </Link>{" "}
            <span aria-hidden="true">›</span>
          </nav>
          <h1 className="text-3xl font-semibold tracking-tight">AI keys</h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Songbird uses your own Anthropic or OpenAI key for AI features. Keys are stored encrypted and never shown
            again in full.
          </p>
        </div>
        <AccountMenu />
      </header>

      {back && (
        <Link href={back.href} className={`w-fit rounded-sm text-sm underline underline-offset-2 ${focusRing}`}>
          {back.label}
        </Link>
      )}

      {status === "unavailable" && (
        <p className={noticeClass}>
          This server uses a shared development provider, and key management is turned off. AI features work without a
          key.
        </p>
      )}
      {status === "ready" && !keysRequired && (
        <p className={noticeClass}>
          This server uses a shared development provider, so AI features work without your own key. Keys you save here
          aren&apos;t used on this server.
        </p>
      )}

      {status === "loading" && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400"
        >
          <Spinner />
          Loading your keys…
        </p>
      )}
      {status === "error" && <ErrorAlert message="Couldn't load your AI keys." onRetry={() => void refresh()} />}

      {status === "ready" && (
        <>
          <ul
            aria-label="AI providers"
            className="divide-y divide-zinc-200 rounded-2xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950"
          >
            {PROVIDERS.map((provider) => {
              const entry = entryFor(provider);
              const name = PROVIDER_LABEL[provider];
              const titleId = `${idPrefix}-${provider}-title`;
              return (
                <li key={provider} className="p-4 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div>
                      <h2 id={titleId} className="text-base font-semibold">
                        {name}
                      </h2>
                      {entry && (
                        <p className={hintClass}>Updated {formatRelativeTime(entry.updated_at)}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {entry ? (
                        <p className="text-sm">
                          Set{" "}
                          <span className="font-mono tabular-nums" aria-hidden="true">
                            ••••{entry.last4}
                          </span>
                          <span className="sr-only">, ending in {spell(entry.last4)}</span>
                        </p>
                      ) : (
                        <p className="text-sm text-zinc-600 dark:text-zinc-400">Not set</p>
                      )}
                      {bothKeys && entry && activeProvider === provider && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-950 dark:bg-emerald-900/50 dark:text-emerald-200">
                          Active
                        </span>
                      )}
                      <div className="flex gap-2">
                        {entry ? (
                          <>
                            <Button
                              id={buttonId(provider, "replace")}
                              className="!py-1"
                              aria-label={`Replace ${name} key`}
                              onClick={() => {
                                opener.current = buttonId(provider, "replace");
                                setEditing(provider);
                              }}
                            >
                              Replace
                            </Button>
                            <Button
                              className="!py-1"
                              aria-label={`Remove ${name} key`}
                              onClick={() => setRemoving(provider)}
                            >
                              Remove
                            </Button>
                          </>
                        ) : (
                          <Button
                            id={buttonId(provider, "set")}
                            className="!py-1"
                            aria-label={`Set ${name} key`}
                            onClick={() => {
                              opener.current = buttonId(provider, "set");
                              setEditing(provider);
                            }}
                          >
                            Set key
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                  {editing === provider && (
                    <KeyForm
                      provider={provider}
                      replacing={entry !== undefined}
                      labelledBy={titleId}
                      onSaved={(summary) => saved(provider, entry !== undefined, summary)}
                      onCancel={() => {
                        pendingFocus.current = opener.current;
                        setEditing(null);
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {bothKeys && (
            <div className="rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
              <ProviderRadioGroup
                active={activeProvider}
                onChanged={(summary) => {
                  setAnnouncement(
                    summary.active_provider
                      ? `${PROVIDER_LABEL[summary.active_provider]} is now used for AI features.`
                      : "",
                  );
                  apply(summary);
                }}
              />
            </div>
          )}
        </>
      )}

      <RemoveKeyDialog
        provider={removing}
        consequence={removing ? consequenceOfRemoving(removing) : ""}
        onRemoved={(summary) => removing && removed(removing, summary)}
        onCancel={() => {
          if (removing) pendingFocus.current = buttonId(removing, "replace");
          setRemoving(null);
        }}
      />
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </main>
  );
}
