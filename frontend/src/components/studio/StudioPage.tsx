"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Row } from "@/generated/Row";
import type { TimeSignature } from "@/generated/TimeSignature";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Transport } from "@/components/editor/Transport";
import { useShortcuts } from "@/components/editor/useEditorShortcuts";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { getInstruments } from "@/lib/api";
import type { LoopRange } from "@/lib/audio/types";
import { useSongPlayback } from "@/lib/audio/useSongPlayback";
import { beatSteps } from "@/lib/pianoRoll";
import { getSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { createSongStore, useSongStore } from "@/lib/song/songStore";
import { newSong, type Song } from "@/lib/song/types";
import { useApiResource } from "@/lib/useApiResource";
import { useStoredHeight } from "@/lib/useStoredHeight";
import { HeightHandle } from "@/components/editor/HeightHandle";
import { Arrangement } from "./Arrangement";
import { AssistantPanel } from "./AssistantPanel";
import { EditorDock } from "./EditorDock";
import { SongHeader } from "./SongHeader";
import type { TrackActions } from "./trackActions";
import { useClipActions } from "./useClipActions";

const STORAGE_FAILURE =
  "Changes aren't being saved. Browser storage is full or unavailable. You can keep editing, but closing this tab will lose your changes.";

const skipLink =
  "sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:text-zinc-900 focus:shadow dark:focus:bg-zinc-900 dark:focus:text-zinc-50";

const DOCK_HEIGHT_KEY = "songbird.studio.dockHeight";
const MIN_DOCK_PX = 200;
const MIN_ARRANGEMENT_PX = 192;
const HANDLE_PX = 8;

const ARRANGEMENT_ID = "studio-arrangement";
const DOCK_ID = "studio-editor";

export function StudioPage({ library: provided }: { library?: SongLibrary }) {
  const library = provided ?? getSongLibrary();
  const [store] = useState(() => createSongStore());
  const song = useSongStore(store, (s) => s.song);
  const selectedTrackId = useSongStore(store, (s) => s.selectedTrackId);
  const selectedClipId = useSongStore(store, (s) => s.selectedClipId);
  const [renamingLoopId, setRenamingLoopId] = useState<string | null>(null);
  const renameInvoker = useRef<HTMLElement | null>(null);
  const instruments = useApiResource(getInstruments);
  const [status, setStatus] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [follow, setFollow] = useState(true);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [loopState, setLoopState] = useState<LoopRange & { measures: number }>({
    start: 1,
    end: 8,
    measures: 8,
  });
  const requestedSong = useRef<string | null | undefined>(undefined);
  const detachAutosave = useRef<(() => void) | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const storage = useStore(library.status);
  const [storedDock, setStoredDock] = useStoredHeight(DOCK_HEIGHT_KEY);
  const mainRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState(0);
  const [dockNatural, setDockNatural] = useState(0);

  // The observer re-measures on any resize so the clamp follows the window, not just the first paint.
  const loaded = song !== null;
  useEffect(() => {
    const main = mainRef.current;
    if (!main || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      setSpace(main.clientHeight - (headerRef.current?.offsetHeight ?? 0));
      setDockNatural(document.getElementById(DOCK_ID)?.offsetHeight ?? 0);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    if (headerRef.current) observer.observe(headerRef.current);
    const dock = document.getElementById(DOCK_ID);
    if (dock) observer.observe(dock);
    return () => observer.disconnect();
  }, [loaded]);
  const maxDock = Math.max(MIN_DOCK_PX, space - MIN_ARRANGEMENT_PX - HANDLE_PX);
  const dockHeight =
    storedDock === null ? null : Math.min(maxDock, Math.max(MIN_DOCK_PX, storedDock));

  const measures = song?.measures ?? 1;
  // A loop chosen for another length is meaningless, so it resets when the length changes.
  const loop: LoopRange =
    loopState.measures === measures
      ? { start: loopState.start, end: loopState.end }
      : { start: 1, end: measures };
  const playback = useSongPlayback(store, instruments.data, loop);

  // Re-attached per song so opening a song is not itself saved, which would reorder the library by open time.
  const show = useCallback(
    (next: Song) => {
      detachAutosave.current?.();
      store.getState().loadSong(next);
      detachAutosave.current = library.autosave(store);
      setLoopState({ start: 1, end: next.measures, measures: next.measures });
    },
    [store, library],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Read once and cleared, so a reload reopens the most recent song rather than pinning the URL's.
      if (requestedSong.current === undefined) {
        requestedSong.current = new URLSearchParams(window.location.search).get("song");
        if (requestedSong.current) window.history.replaceState(null, "", window.location.pathname);
      }
      const requested = requestedSong.current;
      const unreadable = () => library.readStatus.getState().failed;
      const unopenable = () => library.readStatus.getState().invalid;
      let opened = requested ? await library.open(requested) : null;
      // A failed read looks like "not found", and acting on that would create a song and replace last-opened.
      if (unreadable()) {
        if (!cancelled) setLoadFailed(true);
        return;
      }
      const requestedProblem = requested && !opened ? (unopenable() ? "opened" : "found") : null;
      let lastInvalid = false;
      let fallback: "last" | "new" = "last";
      if (!opened) {
        const last = library.getLastSongId();
        opened = last ? await library.open(last) : null;
        if (unreadable()) {
          if (!cancelled) setLoadFailed(true);
          return;
        }
        lastInvalid = !opened && Boolean(last) && unopenable();
      }
      if (!opened) {
        fallback = "new";
        opened = newSong();
        await library.create(opened);
      }
      if (cancelled) return;
      show(opened);
      const outcome =
        fallback === "last" ? "so your last song was opened." : "so a new song was created.";
      if (requestedProblem) {
        setStatus(`That song couldn't be ${requestedProblem}, ${outcome}`);
      } else if (lastInvalid) {
        setStatus(`Your last song couldn't be opened, ${outcome}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [library, show, attempt]);

  useEffect(() => {
    const flush = () => void library.flush();
    const onVisibility = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      detachAutosave.current?.();
      detachAutosave.current = null;
      flush();
    };
  }, [library]);

  useEffect(() => {
    let previous = library.status.getState().ok;
    return library.status.subscribe((s) => {
      if (s.ok && !previous) setStatus("Changes are being saved again.");
      if (s.ok) setBannerDismissed(false);
      previous = s.ok;
    });
  }, [library]);

  const togglePlayback = () => {
    if (!song) return;
    if (!playback.isPlaying) setFollow(true);
    playback.toggle();
  };
  const requestRename = useCallback((loopId: string, invoker: HTMLElement | null) => {
    renameInvoker.current = invoker;
    setRenamingLoopId(loopId);
  }, []);
  const clipActions = useClipActions(store, setStatus, requestRename);
  useShortcuts({
    togglePlayback,
    undo: () => store.getState().undo(),
    redo: () => store.getState().redo(),
    duplicate: () => clipActions.duplicateSelected(),
  });

  const openById = useCallback(
    async (id: string) => {
      const next = await library.open(id);
      if (next) show(next);
      else setStatus("That song couldn't be opened.");
    },
    [library, show],
  );

  const focusTitle = () => requestAnimationFrame(() => titleRef.current?.focus());

  const trackActions = useMemo<TrackActions>(
    () => ({
      select: (id) => store.getState().selectTrack(id),
      rename: (id, name) => store.getState().renameTrack(id, name),
      remove: (id) => {
        const name = store.getState().song?.tracks.find((t) => t.id === id)?.name;
        store.getState().deleteTrack(id);
        if (name) setStatus(`Deleted the ${name} track. Undo to restore.`);
      },
      mixer: (id, patch, options) => store.getState().setMixer(id, patch, options),
      beginGesture: () => store.getState().beginGesture(),
      endGesture: () => store.getState().endGesture(),
    }),
    [store],
  );

  const addTrack = (instrument: InstrumentInfo) => {
    store.getState().addTrack(instrument);
    setStatus(`Added a ${instrument.name} track.`);
    const id = store.getState().selectedTrackId;
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-track-select="${id}"]`);
      el?.focus();
      el?.scrollIntoView?.({ block: "nearest" });
    });
  };

  const setLength = (next: number) => {
    const before = store.getState().song;
    store.getState().setSongLength(next);
    const after = store.getState().song;
    // Loops keep all their notes when the song shrinks, so only clip changes are worth announcing.
    if (before && after && after.tracks.some((t, i) => t.clips !== before.tracks[i]?.clips)) {
      setStatus(`Shortened to ${after.measures} bars. Clips after bar ${after.measures} were trimmed or removed. Undo to restore.`);
    }
  };

  const seek = (trackId: string, measureIndex: number) => {
    store.getState().selectTrack(trackId);
    playback.seek?.(measureIndex + 1);
  };

  const audition = (trackId: string, row: Row, velocity?: number) =>
    void playback.audition(row, { voiceKey: trackId, velocity });

  const track = song?.tracks.find((t) => t.id === selectedTrackId) ?? song?.tracks[0];
  const showBanner = !storage.ok && !bannerDismissed;

  return (
    <main
      ref={mainRef}
      style={
        {
          "--arr-rows": dockHeight === null ? `minmax(${MIN_ARRANGEMENT_PX}px,11fr)` : `minmax(${MIN_ARRANGEMENT_PX}px,1fr)`,
          "--dock-rows": dockHeight === null ? "minmax(16rem,9fr)" : `${dockHeight}px`,
        } as React.CSSProperties
      }
      className="grid min-w-0 bg-zinc-50 text-zinc-900 [--gutter-w:9rem] md:h-dvh md:grid-rows-[auto_var(--arr-rows)_auto_var(--dock-rows)] md:overflow-hidden md:[--gutter-w:16rem] lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem] dark:bg-black dark:text-zinc-50">
      <a href={`#${ARRANGEMENT_ID}`} className={skipLink}>
        Skip to tracks
      </a>
      <a href={`#${DOCK_ID}`} className={skipLink}>
        Skip to piano roll
      </a>
      <div ref={headerRef} className="min-w-0">
        {showBanner && (
          <div className="p-3">
            <ErrorAlert
              message={STORAGE_FAILURE}
              onRetry={() => song && library.save(song)}
              onDismiss={() => setBannerDismissed(true)}
            />
          </div>
        )}
        {loadFailed && (
          <div className="p-3">
            <ErrorAlert
              message="Couldn't read your saved songs, so nothing was opened or changed."
              onRetry={() => {
                setLoadFailed(false);
                setAttempt((a) => a + 1);
              }}
            />
          </div>
        )}
        {song ? (
          <>
            <SongHeader
              store={store}
              library={library}
              song={song}
              titleRef={titleRef}
              onSetLength={setLength}
              onOpenSong={(id) => void openById(id)}
              onSongCreated={(created) => {
                show(created);
                focusTitle();
              }}
              onSongRemoved={(wasCurrent) => {
                if (!wasCurrent) return;
                void (async () => {
                  const [next] = await library.list();
                  if (next) return openById(next.id);
                  const fresh = newSong();
                  await library.create(fresh);
                  show(fresh);
                })();
              }}
              onAnnounce={setStatus}
              onToggleAssistant={() => setAssistantOpen(true)}
              assistantOpen={assistantOpen}
            />
            <p role="status" className="min-h-5 px-4 text-sm text-zinc-600 sm:px-6 dark:text-zinc-400">
              {status}
            </p>
            <div className="px-4 pb-3 sm:px-6">
              <Transport
                playback={playback}
                onToggle={togglePlayback}
                measures={song.measures}
                stepsPerMeasure={song.steps_per_measure}
                beatSteps={beatSteps(song.time_signature as TimeSignature)}
                loop={loop}
                onLoopChange={(r) => setLoopState({ ...r, measures: song.measures })}
                follow={follow}
                onFollowChange={setFollow}
                wholeLabel="Loop whole song"
              />
            </div>
          </>
        ) : (
          <div aria-hidden="true" className="flex flex-col gap-3 px-4 py-4 sm:px-6">
            <div className="h-8 w-64 rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-900" />
            <div className="h-8 w-96 max-w-full rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-900" />
          </div>
        )}
      </div>

      {song && track ? (
        <>
          <Arrangement
            sectionId={ARRANGEMENT_ID}
            song={song}
            selectedTrackId={track.id}
            selectedClipId={selectedClipId}
            instruments={instruments}
            onRetryInstruments={instruments.retry}
            loop={loop}
            subscribePosition={playback.subscribePosition}
            actions={trackActions}
            clipActions={clipActions}
            onAddTrack={addTrack}
            onSeek={seek}
          />
          <HeightHandle
            label="Resize piano roll"
            value={dockHeight ?? Math.min(maxDock, Math.max(MIN_DOCK_PX, dockNatural))}
            min={MIN_DOCK_PX}
            max={maxDock}
            grows="up"
            onChange={setStoredDock}
            onReset={() => setStoredDock(null)}
            className="max-md:hidden"
          />
          <EditorDock
            sectionId={DOCK_ID}
            store={store}
            song={song}
            track={track}
            instruments={instruments}
            onRetryInstruments={instruments.retry}
            follow={follow}
            isPlaying={playback.isPlaying}
            onManualScroll={() => setFollow(false)}
            subscribePosition={playback.subscribePosition}
            onAudition={audition}
            clipActions={clipActions}
            renamingLoopId={renamingLoopId}
            onRenameDone={() => {
              setRenamingLoopId(null);
              const invoker = renameInvoker.current;
              renameInvoker.current = null;
              requestAnimationFrame(() => invoker?.isConnected && invoker.focus());
            }}
          />
        </>
      ) : (
        <>
          <p role="status" className="sr-only">
            Loading song…
          </p>
          <section aria-hidden="true" className="flex flex-col gap-2 border-t border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="h-14 rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-900" />
            ))}
          </section>
          <div aria-hidden="true" className="max-md:hidden" />
          <section aria-hidden="true" className="flex flex-col gap-2 border-t border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="h-5 rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-900" />
            ))}
          </section>
        </>
      )}

      <AssistantPanel className="max-lg:hidden lg:col-start-2 lg:row-span-4 lg:row-start-1" />
      <ModalDialog
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        label="Assistant"
        className="my-0 mr-0 ml-auto h-dvh max-h-dvh w-80 max-w-full rounded-none p-0"
      >
        <AssistantPanel className="h-full border-l-0" />
      </ModalDialog>
    </main>
  );
}
