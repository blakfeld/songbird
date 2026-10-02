"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Row } from "@/generated/Row";
import type { TimeSignature } from "@/generated/TimeSignature";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Transport } from "@/components/editor/Transport";
import { useShortcuts } from "@/components/editor/useEditorShortcuts";
import { useRecordingSession, useTakeFinalizer } from "@/components/editor/useRecordingSession";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { getInstruments } from "@/lib/api";
import type { MidiAccess } from "@/lib/midi/access";
import { createSongTake } from "@/lib/recording/songTake";
import { defaultLoop, type LoopSetting } from "@/lib/loopRegion";
import { songLoop } from "@/lib/song/songLoop";
import { useSongPlayback } from "@/lib/audio/useSongPlayback";
import { beatSteps } from "@/lib/pianoRoll";
import { getSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { createSongStore, useSongStore } from "@/lib/song/songStore";
import { timelineMeasures } from "@/lib/song/songOps";
import { newSong, type Song } from "@/lib/song/types";
import { useApiResource } from "@/lib/useApiResource";
import { useStoredHeight } from "@/lib/useStoredHeight";
import { useStoredValue } from "@/lib/useStoredValue";
import { HeightHandle } from "@/components/editor/HeightHandle";
import { Arrangement } from "./Arrangement";
import { AssistantPanel } from "./AssistantPanel";
import { EditorDock } from "./EditorDock";
import { NoTracksDock } from "./NoTracksDock";
import { TrackGenerateDialog } from "./TrackGenerateDialog";
import { useChat } from "./useChat";
import { useTrackGeneration } from "./useTrackGeneration";
import { SongHeader } from "./SongHeader";
import type { TrackActions } from "./trackActions";
import { useClipActions } from "./useClipActions";
import { useAudioActions } from "./useAudioActions";
import { ReplaceSampleDialog } from "./audio/ReplaceSampleDialog";
import { ImportProgress } from "./samples/ImportProgress";
import { LowStorageDialog, SamplesPanel } from "./samples/SamplesPanel";
import { useSampleImport } from "./samples/useSampleImport";
import type { DropPayload } from "./samples/useSampleDrop";
import type { SampleLibraryEntry } from "@/lib/audio/sampleLibrary";
import { formatPosition } from "@/lib/song/audioTime";
import { TICKS_PER_SIXTEENTH } from "@/lib/song/audioTiming";

const STORAGE_FAILURE =
  "Changes aren't being saved. Browser storage is full or unavailable. You can keep editing, but closing this tab will lose your changes.";

const skipLink =
  "sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:text-zinc-900 focus:shadow dark:focus:bg-zinc-900 dark:focus:text-zinc-50";

const DOCK_HEIGHT_KEY = "songbird.studio.dockHeight";
const DOCK_OPEN_KEY = "songbird.studio.dockOpen";
const MIN_DOCK_PX = 200;
const MIN_ARRANGEMENT_PX = 192;
const HANDLE_PX = 8;

const RECORD_NEEDS_TRACK = "Add a track to record onto.";
const RECORD_NOT_ON_AUDIO = "Select an instrument track to record onto. Audio tracks only play samples.";
const parseOpen = (raw: string) => (raw === "true" ? true : raw === "false" ? false : null);

const ARRANGEMENT_ID = "studio-arrangement";
const DOCK_ID = "studio-editor";

export function StudioPage({
  library: provided,
  midi,
}: {
  library?: SongLibrary;
  // Injectable so tests can drive a fake; defaults to the shared browser singleton.
  midi?: MidiAccess;
}) {
  const library = provided ?? getSongLibrary();
  const [store] = useState(() => createSongStore());
  const song = useSongStore(store, (s) => s.song);
  const gestureBase = useSongStore(store, (s) => s.gestureBase);
  const selectedTrackId = useSongStore(store, (s) => s.selectedTrackId);
  const selectedClipId = useSongStore(store, (s) => s.selectedClipId);
  const generatingTrackId = useSongStore(store, (s) => s.generatingTrackId);
  const [renamingLoopId, setRenamingLoopId] = useState<string | null>(null);
  const renameInvoker = useRef<HTMLElement | null>(null);
  const instruments = useApiResource(getInstruments);
  const [status, setStatus] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [follow, setFollow] = useState(true);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const finalizer = useTakeFinalizer();
  const requestedSong = useRef<string | null | undefined>(undefined);
  const detachAutosave = useRef<(() => void) | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const storage = useStore(library.status);
  const [storedDock, setStoredDock] = useStoredHeight(DOCK_HEIGHT_KEY);
  const [dockOpen, setDockOpen] = useStoredValue(DOCK_OPEN_KEY, true, parseOpen);
  const openDock = useCallback(() => setDockOpen(true), [setDockOpen]);
  const closeDock = useCallback(() => {
    setDockOpen(false);
    // The Close button unmounts with the dock, which would otherwise drop focus to the page body.
    requestAnimationFrame(() => {
      const id = store.getState().selectedClipId;
      const clip = id ? document.querySelector<HTMLElement>(`[data-clip-id="${id}"]`) : null;
      (clip ?? document.getElementById(ARRANGEMENT_ID))?.focus();
    });
  }, [setDockOpen, store]);
  const mainRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState(0);
  const [dockNatural, setDockNatural] = useState(0);

  // The observer re-measures on any resize so the clamp follows the window, not just the first paint.
  const loaded = song !== null;
  // The empty and editor docks are different elements, so the observer has to re-attach when the kind changes.
  const dockKind = !dockOpen ? "closed" : song && song.tracks.length > 0 ? "editor" : "empty";
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
  }, [loaded, dockKind]);
  const maxDock = Math.max(MIN_DOCK_PX, space - MIN_ARRANGEMENT_PX - HANDLE_PX);
  const dockHeight =
    storedDock === null ? null : Math.min(maxDock, Math.max(MIN_DOCK_PX, storedDock));

  const loop = useMemo(() => (song ? songLoop(song) : defaultLoop()), [song]);
  const setLoop = useCallback((l: LoopSetting) => store.getState().setLoop(l), [store]);
  const playback = useSongPlayback(store, instruments.data, loop);

  // Re-attached per song so opening a song is not itself saved, which would reorder the library by open time.
  const show = useCallback(
    (next: Song) => {
      detachAutosave.current?.();
      store.getState().loadSong(next);
      detachAutosave.current = library.autosave(store);
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

  const liveTrack = song?.tracks.find((t) => t.id === selectedTrackId) ?? song?.tracks[0];
  const liveInstrument = instruments.data?.find((i) => i.id === liveTrack?.instrument);
  const liveTrackId = liveTrack?.id;
  const liveRows = liveInstrument?.rows;
  const liveOneShot = liveInstrument?.kind === "drums";
  const liveTarget = useMemo(
    () => (liveTrackId && liveRows ? { rows: liveRows, voiceKey: liveTrackId, oneShot: liveOneShot } : null),
    [liveTrackId, liveRows, liveOneShot],
  );
  // Read from the store at start so the take stays on that track even if the selection moves later.
  const createTarget = useCallback(() => {
    const { song: current, selectedTrackId: id } = store.getState();
    const trackId = current?.tracks.find((t) => t.id === id)?.id ?? current?.tracks[0]?.id;
    return trackId ? createSongTake(store, trackId) : null;
  }, [store]);
  const recordBlockedReason =
    song && song.tracks.length === 0
      ? RECORD_NEEDS_TRACK
      : liveTrack?.instrument === "audio"
        ? RECORD_NOT_ON_AUDIO
        : null;
  const session = useRecordingSession({
    engine: playback.engine,
    playback,
    loop,
    measures: song?.measures ?? 0,
    stepsPerMeasure: song?.steps_per_measure ?? 0,
    liveTarget,
    createTarget,
    onAnnounce: setStatus,
    midi,
    finalizer,
    blockedReason: recordBlockedReason,
  });

  const { guardEdit } = session;
  const togglePlayback = () => {
    if (!song) return;
    session.guardToggle(() => {
      if (!playback.isPlaying) setFollow(true);
      playback.toggle();
    });
  };
  const requestRename = useCallback((loopId: string, invoker: HTMLElement | null) => {
    renameInvoker.current = invoker;
    setRenamingLoopId(loopId);
  }, []);
  const clipActions = useClipActions(store, setStatus, requestRename, session.guardEdit, openDock);
  useShortcuts({
    togglePlayback,
    toggleRecord: session.toggleRecord,
    undo: () => session.guardEdit(() => store.getState().undo()),
    redo: () => session.guardEdit(() => store.getState().redo()),
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

  const generation = useTrackGeneration(store, setStatus, guardEdit);
  const { open: openGenerate } = generation;
  const chat = useChat(store, setStatus);

  // UI state rather than song state, so opening a panel is never an undo step or a saved change.
  const [soundTrackId, setSoundTrackId] = useState<string | null>(null);
  if (soundTrackId !== null && song && !song.tracks.some((t) => t.id === soundTrackId))
    setSoundTrackId(null);

  const trackActions = useMemo<TrackActions>(
    () => ({
      select: (id) => store.getState().selectTrack(id),
      rename: (id, name) => guardEdit(() => store.getState().renameTrack(id, name)),
      remove: (id) => {
        const name = store.getState().song?.tracks.find((t) => t.id === id)?.name;
        guardEdit(() => store.getState().deleteTrack(id));
        setSoundTrackId((open) => (open === id ? null : open));
        if (name) setStatus(`Deleted the ${name} track. Undo to restore.`);
      },
      move: (id, toIndex) => guardEdit(() => store.getState().moveTrack(id, toIndex)),
      mixer: (id, patch, options) => store.getState().setMixer(id, patch, options),
      sound: (id, patch, options) => store.getState().setSound(id, patch, options),
      resetSound: (id) => store.getState().resetSound(id),
      generate: openGenerate,
      beginGesture: () => guardEdit(() => store.getState().beginGesture()),
      endGesture: () => store.getState().endGesture(),
    }),
    [store, guardEdit, openGenerate],
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

  // The last position the transport reported, in steps, so placing "at the playhead" needs no per-frame render.
  const playhead = useRef(0);
  // Rendered state moves once per measure at most, so the panel's label follows playback without a render per frame.
  const [labelStep, setLabelStep] = useState(0);
  const { subscribePosition } = playback;
  useEffect(
    () =>
      subscribePosition((step) => {
        if (step === null) return;
        playhead.current = step;
        const spm = store.getState().song?.steps_per_measure ?? 1;
        setLabelStep(Math.floor(step / spm) * spm);
      }),
    [subscribePosition, store],
  );
  const playheadTicks = () => Math.floor(playhead.current) * TICKS_PER_SIXTEENTH;

  const seek = (trackId: string, measureIndex: number) => {
    store.getState().selectTrack(trackId);
    playhead.current = measureIndex * (store.getState().song?.steps_per_measure ?? 0);
    setLabelStep(playhead.current);
    playback.seek?.(measureIndex + 1);
  };

  const audition = (trackId: string, row: Row, velocity?: number) =>
    void playback.audition(row, { voiceKey: trackId, velocity });


  const [samplesOpen, setSamplesOpen] = useState(false);
  const samplesButton = useRef<HTMLButtonElement>(null);
  const samplesSearch = useRef<HTMLInputElement>(null);
  const showSamples = useCallback(() => {
    setSamplesOpen(true);
    requestAnimationFrame(() => samplesSearch.current?.focus());
  }, []);
  const [replacing, setReplacing] = useState<{ trackId: string; clipId: string; invoker: HTMLElement | null } | null>(null);
  const importer = useSampleImport();
  const fileInput = useRef<HTMLInputElement>(null);
  // The picker returns asynchronously, so its destination is parked here instead of in render state.
  const pickTarget = useRef<{ place: boolean; trackId: string | null; startTicks: number | null; invoker: HTMLElement | null }>({
    place: false,
    trackId: null,
    startTicks: null,
    invoker: null,
  });

  const importHere = useCallback(
    (trackId: string | null, startTicks: number | null, options?: { single?: boolean }) => {
      pickTarget.current = {
        place: true,
        trackId,
        startTicks,
        invoker: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      };
      const input = fileInput.current;
      if (!input) return;
      input.multiple = !options?.single;
      input.value = "";
      input.click();
    },
    [],
  );
  const requestReplace = useCallback(
    (trackId: string, clipId: string, invoker: HTMLElement | null) => setReplacing({ trackId, clipId, invoker }),
    [],
  );
  const audio = useAudioActions(store, setStatus, guardEdit, openDock, { requestReplace, importHere });

  const { importFiles } = importer;
  const importAndPlace = useCallback(
    async (files: File[], target: { place: boolean; trackId: string | null; startTicks: number | null }) => {
      setStatus(files.length === 1 ? `Importing ${files[0].name}…` : `Importing ${files.length} files…`);
      const songId = store.getState().song?.id;
      const entries = await importFiles(files);
      if (entries.length === 0) {
        setStatus(
          files.length === 1
            ? `Couldn't import ${files[0].name}.`
            : "Nothing was imported.",
        );
        return;
      }
      if (!target.place) {
        setStatus(entries.length === 1 ? `Imported ${entries[0].name} to the library.` : `Imported ${entries.length} samples to the library.`);
        return;
      }
      // Decoding can take seconds, and a track id from the previous song would place into the wrong document.
      if (store.getState().song?.id !== songId) {
        setStatus("Imported to the library. The song changed meanwhile, so nothing was placed.");
        return;
      }
      audio.placeMany(target.trackId, entries, target.startTicks ?? playheadTicks(), "import");
    },
    [importFiles, audio, store],
  );

  const onSampleDrop = (trackId: string | null, startTicks: number, _free: boolean, payload: DropPayload) => {
    if (payload.kind === "sample") audio.place(trackId, payload.entry, startTicks);
    else void importAndPlace(payload.files, { place: true, trackId, startTicks });
  };

  const addAudioTrack = () => {
    store.getState().addAudioTrack();
    setStatus("Added an audio track.");
    const id = store.getState().selectedTrackId;
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-track-select="${id}"]`);
      el?.focus();
      el?.scrollIntoView?.({ block: "nearest" });
    });
  };

  const selectedAudioTrack = song?.tracks.find((t) => t.id === selectedTrackId && t.instrument === "audio") ?? null;
  const placeFromPanel = (entry: SampleLibraryEntry) => {
    if (!selectedAudioTrack) {
      setStatus("Select an audio track first.");
      return;
    }
    audio.place(selectedAudioTrack.id, entry, playheadTicks());
  };

  const track = song?.tracks.find((t) => t.id === selectedTrackId) ?? song?.tracks[0] ?? null;
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
      className={`grid min-w-0 bg-zinc-50 text-zinc-900 [--gutter-w:9rem] md:h-dvh ${dockOpen ? "md:grid-rows-[auto_var(--arr-rows)_auto_var(--dock-rows)]" : "md:grid-rows-[auto_minmax(0,1fr)]"} md:overflow-hidden md:[--gutter-w:16rem] lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem] dark:bg-black dark:text-zinc-50`}>
      <a href={`#${ARRANGEMENT_ID}`} className={skipLink}>
        Skip to tracks
      </a>
      {dockOpen && (
        <a href={`#${DOCK_ID}`} className={skipLink}>
          Skip to piano roll
        </a>
      )}
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
              instruments={instruments.data}
              titleRef={titleRef}
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
              onToggleSamples={() => (samplesOpen ? setSamplesOpen(false) : showSamples())}
              samplesOpen={samplesOpen}
              samplesButtonRef={samplesButton}
              guardEdit={session.guardEdit}
            />
            <p role="status" className="min-h-5 px-4 text-sm text-zinc-600 sm:px-6 dark:text-zinc-400">
              {status}
            </p>
            <div className="px-4 sm:px-6">
              <ImportProgress importer={importer} />
            </div>
            <div className="px-4 pb-3 sm:px-6">
              <Transport
                playback={playback}
                onToggle={togglePlayback}
                stepsPerMeasure={song.steps_per_measure}
                beatSteps={beatSteps(song.time_signature as TimeSignature)}
                loop={loop}
                onLoopChange={setLoop}
                follow={follow}
                onFollowChange={setFollow}
                recording={session.recording}
                onRecordToggle={session.onRecordToggle}
                subscribeCountIn={session.subscribeCountIn}
                onAnnounce={setStatus}
                midi={midi}
                recordBlockedReason={recordBlockedReason}
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

      {song ? (
        <>
          <Arrangement
            sectionId={ARRANGEMENT_ID}
            song={song}
            timeline={timelineMeasures(gestureBase ?? song)}
            selectedTrackId={track?.id ?? null}
            selectedClipId={selectedClipId}
            instruments={instruments}
            onRetryInstruments={instruments.retry}
            loop={loop}
            onLoopChange={setLoop}
            subscribePosition={playback.subscribePosition}
            actions={trackActions}
            soundTrackId={soundTrackId}
            onSoundTrack={setSoundTrackId}
            clipActions={clipActions}
            audioActions={audio}
            onSampleDrop={onSampleDrop}
            generatingTrackId={generatingTrackId}
            onAddTrack={addTrack}
            onAddAudio={addAudioTrack}
            onSeek={seek}
          />
          {dockOpen && (
            <>
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
              {track ? (
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
                  audioActions={audio}
                  onShowSamples={showSamples}
                  onAnnounce={setStatus}
                  renamingLoopId={renamingLoopId}
                  onRenameDone={() => {
                    setRenamingLoopId(null);
                    const invoker = renameInvoker.current;
                    renameInvoker.current = null;
                    requestAnimationFrame(() => invoker?.isConnected && invoker.focus());
                  }}
                  onClose={closeDock}
                />
              ) : (
                <NoTracksDock sectionId={DOCK_ID} onClose={closeDock} />
              )}
            </>
          )}
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
          {dockOpen && (
            <>
              <div aria-hidden="true" className="max-md:hidden" />
              <section aria-hidden="true" className="flex flex-col gap-2 border-t border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                {Array.from({ length: 12 }, (_, i) => (
                  <div key={i} className="h-5 rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-900" />
                ))}
              </section>
            </>
          )}
        </>
      )}

      {song && track && (
        <TrackGenerateDialog
          open={generation.dialog !== null}
          song={song}
          track={song.tracks.find((t) => t.id === generation.dialog?.trackId) ?? track}
          initialPrompt={generation.dialog?.prompt}
          initialError={generation.dialog?.error}
          onSubmit={(request) => generation.dialog && void generation.submit(generation.dialog.trackId, request)}
          onClose={generation.close}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        data-testid="audio-file-input"
        accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.aac,.flac,.ogg,.opus"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          const target = pickTarget.current;
          e.target.value = "";
          // The picker's own focus return is unreliable across browsers, so the opener is refocused explicitly.
          requestAnimationFrame(() => target.invoker?.isConnected && target.invoker.focus());
          if (files.length > 0) void importAndPlace(files, target);
        }}
      />
      {song && samplesOpen && (
        <SamplesPanel
          songSampleIds={new Set((song.samples ?? []).map((s) => s.id))}
          targetLabel={
            selectedAudioTrack ? `Places on: ${selectedAudioTrack.name} at ${formatPosition(labelStep * TICKS_PER_SIXTEENTH, song)}` : null
          }
          searchRef={samplesSearch}
          onImportRequest={() => {
            pickTarget.current = { place: false, trackId: null, startTicks: null, invoker: null };
            fileInput.current?.click();
          }}
          onDropFiles={(files) => void importAndPlace(files, { place: false, trackId: null, startTicks: null })}
          onPlace={placeFromPanel}
          countSongs={(id) => library.songsUsingSample(id)}
          onClose={() => {
            setSamplesOpen(false);
            requestAnimationFrame(() => samplesButton.current?.focus());
          }}
        />
      )}
      <LowStorageDialog importer={importer} />
      <ReplaceSampleDialog
        open={replacing !== null}
        songSampleIds={new Set((song?.samples ?? []).map((s) => s.id))}
        currentSampleId={
          replacing
            ? song?.tracks.find((t) => t.id === replacing.trackId)?.audio_clips?.find((c) => c.id === replacing.clipId)?.sample_id
            : undefined
        }
        onPick={(entry) => {
          if (!replacing) return;
          const { trackId, clipId, invoker } = replacing;
          setReplacing(null);
          audio.replace(trackId, clipId, entry);
          requestAnimationFrame(() => invoker?.isConnected && invoker.focus());
        }}
        onClose={() => {
          const invoker = replacing?.invoker;
          setReplacing(null);
          requestAnimationFrame(() => invoker?.isConnected && invoker.focus());
        }}
      />
      <AssistantPanel song={song} chat={chat} instruments={instruments.data} className={`max-lg:hidden lg:col-start-2 ${dockOpen ? "lg:row-span-4" : "lg:row-span-2"} lg:row-start-1`} />
      <ModalDialog
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        label="Assistant"
        className="my-0 mr-0 ml-auto h-dvh max-h-dvh w-80 max-w-full rounded-none p-0"
      >
        <AssistantPanel song={song} chat={chat} instruments={instruments.data} className="h-full border-l-0" />
      </ModalDialog>
    </main>
  );
}
