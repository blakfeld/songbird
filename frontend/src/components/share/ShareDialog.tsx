"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { hintClass, inputClass, labelClass } from "@/components/ui/classes";
import { hasLocalAudio } from "@/lib/listen/listenSong";
import { describeExpiry, EXPIRY_CHOICES, expiryFrom, type ExpiryChoice } from "@/lib/share/expiry";
import { shareApi, type CreatedShare, type ShareApi, type ShareLink, type ShareMode } from "@/lib/share/shareApi";
import type { Song } from "@/lib/song/types";

const LABEL_MAX = 80;
const LOAD_FAILURE = "Couldn't load this song's share links.";
const FALLBACK_FAILURE = "Something went wrong. Please try again.";

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : FALLBACK_FAILURE);

// The choice is made before the link exists, so the warning has to be where the owner is deciding.
export const AUDIO_WARNING =
  "Audio tracks, which hold recordings and samples, are stored only in your browser. They will be silent for listeners.";

export function ShareDialog({
  open,
  onClose,
  projectId,
  song,
  api = shareApi,
  now = Date.now,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  song: Song;
  // Injectable so tests can drive the dialog without a server.
  api?: ShareApi;
  now?: () => number;
}) {
  const titleId = useId();
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      className="m-auto max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-2xl p-6"
    >
      <ShareDialogBody titleId={titleId} onClose={onClose} projectId={projectId} song={song} api={api} now={now} />
    </ModalDialog>
  );
}

function ShareDialogBody({
  titleId,
  onClose,
  projectId,
  song,
  api,
  now,
}: {
  titleId: string;
  onClose: () => void;
  projectId: string;
  song: Song;
  api: ShareApi;
  now: () => number;
}) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [created, setCreated] = useState<CreatedShare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    api.list(projectId).then(
      (all) => {
        if (cancelled) return;
        setLinks(all);
        setLoadFailed(false);
      },
      () => !cancelled && setLoadFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [api, projectId, attempt]);

  const audioWarning = song.tracks.some((t) => hasLocalAudio(t) && (t.instrument !== "audio" || (t.audio_clips?.length ?? 0) > 0));

  // One guard for every mutation, so a double click cannot send the same change twice.
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const replace = (next: ShareLink) => setLinks((all) => all?.map((l) => (l.id === next.id ? next : l)) ?? null);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="text-lg font-semibold">
            Share &ldquo;{song.name}&rdquo;
          </h2>
          <p className={hintClass}>Anyone with a link can listen and see the lyrics. They don&apos;t need an account.</p>
        </div>
        <Button onClick={onClose} aria-label="Close share dialog">
          Close
        </Button>
      </div>

      {error && <ErrorAlert message={error} onDismiss={() => setError(null)} />}

      <CreateForm
        audioWarning={audioWarning}
        busy={busy}
        onCreate={({ expiry, ...share }) =>
          run(async () => {
            const result = await api.create(projectId, { ...share, expires_at: expiryFrom(expiry, now()) });
            setCreated(result);
            reload();
          })
        }
      />

      {created && <NewLink created={created} />}

      <section aria-labelledby={`${titleId}-links`} className="flex flex-col gap-2">
        <h3 id={`${titleId}-links`} className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Links for this song
        </h3>
        {loadFailed ? (
          <ErrorAlert message={LOAD_FAILURE} onRetry={reload} />
        ) : links === null ? (
          <p role="status" className={hintClass}>
            Loading links…
          </p>
        ) : links.length === 0 ? (
          <p className={hintClass}>No links yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {links.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                busy={busy}
                confirming={confirming === link.id}
                onConfirm={(on) => setConfirming(on ? link.id : null)}
                now={now}
                onEdit={(edit) =>
                  run(async () => {
                    replace(
                      await api.update(projectId, link.id, {
                        label: link.label,
                        expires_at: link.expires_at,
                        allow_comments: link.allow_comments,
                        allow_downloads: link.allow_downloads,
                        ...edit,
                      }),
                    );
                  })
                }
                onRevoke={() =>
                  run(async () => {
                    await api.revoke(projectId, link.id);
                    setConfirming(null);
                    reload();
                  })
                }
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface CreateValues {
  mode: ShareMode;
  expiry: ExpiryChoice;
  allow_comments: boolean;
  allow_downloads: boolean;
  label?: string;
}

function CreateForm({
  audioWarning,
  busy,
  onCreate,
}: {
  audioWarning: boolean;
  busy: boolean;
  onCreate: (values: CreateValues) => Promise<void>;
}) {
  const ids = { mode: useId(), expiry: useId(), label: useId(), downloads: useId() };
  const [mode, setMode] = useState<ShareMode>("live");
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [comments, setComments] = useState(true);
  const [downloads, setDownloads] = useState(false);
  const [label, setLabel] = useState("");

  return (
    <form
      aria-label="Create a link"
      className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = label.trim();
        void onCreate({
          mode,
          expiry,
          allow_comments: comments,
          allow_downloads: downloads,
          ...(trimmed && { label: trimmed }),
        });
      }}
    >
      {audioWarning && (
        <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {AUDIO_WARNING}
        </p>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className={labelClass}>Link type</legend>
        {(
          [
            ["live", "Live", "Always plays the latest saved version."],
            ["snapshot", "Snapshot", "Plays the song as it is now, even if you keep editing."],
          ] as const
        ).map(([value, name, hint]) => (
          <label key={value} className="flex items-start gap-2 text-sm">
            <input type="radio" name={ids.mode} checked={mode === value} onChange={() => setMode(value)} className="mt-1" />
            <span>
              <span className="font-medium">{name}</span>
              <span className={`block ${hintClass}`}>{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Expires" htmlFor={ids.expiry}>
          <Select id={ids.expiry} value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryChoice)}>
            {EXPIRY_CHOICES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Label (only you see it)" htmlFor={ids.label}>
          <input
            id={ids.label}
            value={label}
            maxLength={LABEL_MAX}
            onChange={(e) => setLabel(e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>
      <div className="flex flex-col gap-2">
        <Switch label="Allow comments" checked={comments} onChange={setComments} />
        <Switch label="Allow downloads" checked={downloads} onChange={setDownloads} describedBy={ids.downloads} />
        <p id={ids.downloads} className={hintClass}>
          Downloads offer MIDI and WAV files. Listeners can still record what they hear, so this expresses your intent
          and doesn&apos;t prevent copying.
        </p>
      </div>
      <div>
        <Button type="submit" variant="primary" disabled={busy}>
          Create link
        </Button>
      </div>
    </form>
  );
}

function NewLink({ created }: { created: CreatedShare }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const url = `${window.location.origin}${created.url}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setStatus("Link copied.");
    } catch {
      // Blocked clipboard access is common off HTTPS, so the text is selected for the owner to copy by hand.
      input.current?.select();
      setStatus("Couldn't copy automatically. The link is selected; copy it with your keyboard.");
    }
  }

  return (
    <section aria-label="New link" className="flex flex-col gap-2 rounded-xl border border-indigo-300 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950/30">
      <label htmlFor={id} className={labelClass}>
        Link
      </label>
      <div className="flex gap-2">
        <input ref={input} id={id} readOnly value={url} onFocus={(e) => e.currentTarget.select()} className={`${inputClass} min-w-0 flex-1 font-mono`} />
        <Button onClick={() => void copy()}>Copy link</Button>
      </div>
      <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
        Copy this link now. It won&apos;t be shown again.
      </p>
      <p role="status" className={hintClass}>
        {status}
      </p>
    </section>
  );
}

const STATUS_LABELS = { active: "Active", expired: "Expired", revoked: "Revoked" } as const;

function LinkRow({
  link,
  busy,
  confirming,
  onConfirm,
  onEdit,
  onRevoke,
  now,
}: {
  link: ShareLink;
  busy: boolean;
  confirming: boolean;
  onConfirm: (on: boolean) => void;
  onEdit: (edit: Partial<Pick<ShareLink, "allow_comments" | "allow_downloads" | "expires_at">>) => Promise<void>;
  onRevoke: () => Promise<void>;
  now: () => number;
}) {
  const titleId = useId();
  const title = link.label || `Link ${link.token_prefix}…`;
  const editable = link.status !== "revoked";
  return (
    <li role="group" aria-labelledby={titleId} className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span id={titleId} className="min-w-0 break-words font-medium">
          {title}
        </span>
        <span className={hintClass}>
          {link.mode === "live" ? "Live" : "Snapshot"} · {STATUS_LABELS[link.status]}
        </span>
      </div>
      <p className={hintClass}>
        {describeExpiry(link.expires_at)}
        {link.unresolved_comments > 0 &&
          ` · ${link.unresolved_comments} unresolved ${link.unresolved_comments === 1 ? "comment" : "comments"}`}
      </p>
      {editable && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Switch
              label="Allow comments"
              checked={link.allow_comments}
              onChange={(next) => void onEdit({ allow_comments: next })}
            />
            <Switch
              label="Allow downloads"
              checked={link.allow_downloads}
              onChange={(next) => void onEdit({ allow_downloads: next })}
            />
            <Select
              aria-label="Change expiry"
              value="keep"
              disabled={busy}
              className="h-8 w-auto"
              onChange={(e) => {
                const choice = e.target.value as ExpiryChoice;
                void onEdit({ expires_at: expiryFrom(choice, now()) });
              }}
            >
              <option value="keep" disabled>
                Change expiry…
              </option>
              {EXPIRY_CHOICES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id === "never" ? "Never expires" : `Expires in ${c.label}`}
                </option>
              ))}
            </Select>
          </div>
          {confirming ? (
            <div role="group" aria-label="Confirm revoke" className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 basis-48">Revoke this link? Listeners lose access immediately.</p>
              <Button autoFocus onClick={() => onConfirm(false)}>
                Keep link
              </Button>
              <Button
                disabled={busy}
                className="!border-transparent !bg-red-600 !text-white hover:!bg-red-700"
                onClick={() => void onRevoke()}
              >
                Confirm revoke
              </Button>
            </div>
          ) : (
            <div>
              <Button onClick={() => onConfirm(true)}>Revoke</Button>
            </div>
          )}
        </>
      )}
    </li>
  );
}
