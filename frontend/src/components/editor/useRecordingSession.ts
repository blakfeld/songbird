"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PlaybackEngine } from "@/lib/audio/engine";
import type { Playback } from "@/lib/audio/types";
import { useMetronomeSettings } from "@/lib/audio/useMetronomeSettings";
import type { LoopSetting } from "@/lib/loopRegion";
import type { MidiAccess } from "@/lib/midi/access";
import { createInputRouter, type InputRouter, type LiveTarget } from "@/lib/recording/router";
import type { AudioTakeOutcome, TakeTarget } from "@/lib/recording/take";
import { SOUND_BLOCKED, audioTakeMessage, takeEndedMessage, takeStartedMessage } from "./recordingMessages";
import { useMidiState } from "./useMidiState";
import { useRecordControl, type RecordingState } from "./useRecordControl";

interface Options {
  engine: PlaybackEngine;
  playback: Pick<Playback, "isPlaying" | "status" | "subscribePosition">;
  loop: LoopSetting;
  measures: number;
  stepsPerMeasure: number;
  // Must be referentially stable between real changes: a new object re-prepares the live voice.
  liveTarget: LiveTarget | null;
  // Called when a take starts, so a page can pick its target (such as the selected track) at that moment. An audio
  // take is asynchronous because opening its input may need the user's permission, and a refusal carries its reason.
  createTarget: () => TakeTarget | null | Promise<{ target: TakeTarget } | { reason: string }>;
  onAnnounce: (msg: string) => void;
  midi?: MidiAccess;
  blockedReason?: string | null;
  needsMidi?: boolean;
  // Cleared when a take starts, so an old failure does not outlive the next attempt.
  onError?: (message: string | null) => void;
  onBlocked?: (reason: string) => void;
  // From useTakeFinalizer; lets the take end before the page's other teardown runs.
  finalizer?: RefObject<(() => void) | null>;
}

// Effect cleanups run in declaration order, so this has to be called before the playback hooks and any autosave
// effect. Ending the take afterwards would read step positions from a stopped engine and write to an unsaved store.
export function useTakeFinalizer() {
  const ref = useRef<(() => void) | null>(null);
  useEffect(() => () => ref.current?.(), []);
  return ref;
}

// One state machine for every page, so count-in, punch-in and stop rules cannot drift between them.
export function useRecordingSession(options: Options) {
  const { engine, playback, liveTarget } = options;
  const { access, snapshot } = useMidiState(options.midi);
  const granted = snapshot.status === "granted";
  const { metronome, countIn } = useMetronomeSettings();

  const [recording, setRecording] = useState<RecordingState>("idle");
  const phase = useRef<RecordingState>("idle");
  const router = useRef<InputRouter | null>(null);
  // Read when the engine plays, because starting consumes a pending seek and the announcement must still name its bar.
  const plannedBar = useRef(1);
  const soundHinted = useRef(false);
  // Bumped whenever the router is torn down, so a take prepared before that is never started on a new one.
  const epoch = useRef(0);
  // Play loads asynchronously, so "not playing" only means "ended" once it has been seen playing.
  const sawPlaying = useRef(false);
  const lastStep = useRef<number | null>(null);

  const latest = useRef({ ...options, countIn });
  useEffect(() => {
    latest.current = { ...options, countIn };
  });

  const setPhase = useCallback((next: RecordingState) => {
    phase.current = next;
    setRecording(next);
  }, []);

  useEffect(() => {
    engine.setMetronome(metronome);
  }, [engine, metronome]);

  useEffect(() => playback.subscribePosition((s) => (lastStep.current = s)), [playback]);

  useEffect(() => {
    const created = createInputRouter(access, engine, undefined, () => {
      // Other causes of silence, such as samples still loading, are not fixed by a click.
      if (!engine.liveBlocked() || soundHinted.current) return;
      soundHinted.current = true;
      latest.current.onAnnounce(SOUND_BLOCKED);
    });
    router.current = created;
    const { finalizer } = latest.current;
    if (finalizer) finalizer.current = () => void created.endTake();
    return () => {
      epoch.current += 1;
      if (finalizer) finalizer.current = null;
      // Disposing commits the take, so the phase has to leave "recording" with it or a new router inherits a take it never began.
      created.dispose();
      router.current = null;
      phase.current = "idle";
      setRecording("idle");
    };
  }, [access, engine]);

  useEffect(() => {
    router.current?.setLiveTarget(liveTarget);
    // Without this the first key press would find no audio graph and be dropped.
    if (granted && liveTarget) void engine.prepareLive(liveTarget.voiceKey, liveTarget.rows);
  }, [access, engine, liveTarget, granted]);

  // A remembered grant is restored on load without any click, and the browser keeps the audio context suspended
  // until the page has had a user activation, which a MIDI message is not.
  useEffect(() => {
    if (!granted || !liveTarget) return;
    const resume = () => {
      document.removeEventListener("pointerdown", resume, true);
      document.removeEventListener("keydown", resume, true);
      soundHinted.current = false;
      void engine.prepareLive(liveTarget.voiceKey, liveTarget.rows);
    };
    document.addEventListener("pointerdown", resume, true);
    document.addEventListener("keydown", resume, true);
    return () => {
      document.removeEventListener("pointerdown", resume, true);
      document.removeEventListener("keydown", resume, true);
    };
  }, [engine, liveTarget, granted]);

  const begin = useCallback((target: TakeTarget): boolean => {
    const { loop, measures, stepsPerMeasure } = latest.current;
    if (!router.current) return false;
    const region = loop.enabled ? loop.region : null;
    router.current.startTake(target, {
      range: {
        start: region ? (region.start - 1) * stepsPerMeasure : 0,
        end: (region ? region.end : measures) * stepsPerMeasure,
      },
      looping: loop.enabled,
    });
    return true;
  }, []);

  const finish = useCallback(() => {
    const summary = router.current?.endTake() ?? { recorded: 0, dropped: {} };
    setPhase("idle");
    if (summary.settled) {
      // Storing the audio outlasts the take, so the result is announced when it lands.
      void summary.settled.then((outcome: AudioTakeOutcome) => {
        const message = audioTakeMessage(outcome);
        latest.current.onAnnounce(message);
        // A failed save loses a performance, which a line in the status region is too easy to miss.
        if (outcome.kind === "failed") latest.current.onError?.(message);
      });
      return;
    }
    const clipLimit = summary.dropped["clip-limit"];
    const loopLimit = summary.dropped["loop-limit"];
    const noRoom = summary.dropped["no-room"];
    latest.current.onAnnounce(
      takeEndedMessage(summary.recorded, { clipLimit, loopLimit, noRoom }),
    );
  }, [setPhase]);

  const abandon = useCallback(() => {
    router.current?.discardTake();
    setPhase("idle");
  }, [setPhase]);

  const cancel = useCallback(() => {
    abandon();
    engine.stop();
  }, [abandon, engine]);

  const go = useCallback((target: TakeTarget) => {
    const { onAnnounce, playback: pb, countIn: wantCountIn, stepsPerMeasure } = latest.current;
    if (!begin(target)) {
      // An audio target already holds the microphone, which only discarding gives back.
      target.discard();
      return;
    }
    latest.current.onError?.(null);
    // A take that hits a limit cannot stop the transport itself, so it asks here and keeps what it recorded.
    target.onLimit?.((limit) => {
      if (phase.current === "idle") return;
      finish();
      // A seek ends the take but not the playback the user just moved.
      if (limit !== "seek") engine.stop();
    });
    if (pb.isPlaying) {
      sawPlaying.current = true;
      setPhase("recording");
      const step = lastStep.current;
      const bar = step === null ? 1 : Math.floor(step / stepsPerMeasure) + 1;
      onAnnounce(takeStartedMessage(bar));
      return;
    }
    sawPlaying.current = false;
    if (wantCountIn) {
      setPhase("counting-in");
      void engine.play({ countIn: true });
    } else {
      setPhase("recording");
      onAnnounce(takeStartedMessage(plannedBar.current));
      void engine.play();
    }
  }, [begin, finish, engine, setPhase]);

  const preparing = useRef(false);
  const start = useCallback(() => {
    plannedBar.current = engine.startMeasure();
    const current = phase.current;
    if (current === "counting-in") return cancel();
    if (current === "recording") return finish();
    const created = latest.current.createTarget();
    if (!created) return;
    if (!("then" in created)) return go(created);
    // A second press while the browser asks for the microphone must not start a second take.
    if (preparing.current) return;
    preparing.current = true;
    const mine = epoch.current;
    void created
      .then((result) => {
        if ("reason" in result) return latest.current.onAnnounce(result.reason);
        // The page may have gone, or its router been replaced, while the browser asked for the microphone.
        if (mine !== epoch.current) result.target.discard();
        else go(result.target);
      })
      .finally(() => {
        preparing.current = false;
      });
  }, [cancel, finish, go, engine]);

  useEffect(
    () =>
      engine.subscribeCountInEnd(() => {
        if (phase.current !== "counting-in") return;
        setPhase("recording");
        latest.current.onAnnounce(takeStartedMessage(plannedBar.current));
      }),
    [engine, setPhase],
  );

  const { isPlaying, status } = playback;
  useEffect(() => {
    if (isPlaying) {
      sawPlaying.current = true;
      return;
    }
    if (phase.current === "idle") return;
    // The engine stops on its own (end of a play-once run, audio failure), which only this effect can observe.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (status === "error") abandon();
    else if (sawPlaying.current) {
      if (phase.current === "counting-in") abandon();
      else finish();
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [isPlaying, status, finish, abandon]);

  // An edit made mid-take would otherwise be overwritten by, or reordered around, the notes still being recorded.
  const guardEdit = useCallback(
    (edit: () => void) => {
      if (phase.current === "recording") finish();
      edit();
    },
    [finish],
  );

  const guardToggle = useCallback(
    (toggle: () => void) => {
      if (phase.current === "counting-in") return cancel();
      if (phase.current === "recording") finish();
      toggle();
    },
    [cancel, finish],
  );

  const { toggleRecord } = useRecordControl({
    playback,
    recording,
    onRecordToggle: start,
    onAnnounce: options.onAnnounce,
    midi: options.midi,
    blockedReason: options.blockedReason,
    needsMidi: options.needsMidi,
    onBlocked: options.onBlocked,
  });

  return {
    recording,
    onRecordToggle: start,
    toggleRecord,
    guardToggle,
    guardEdit,
    subscribeCountIn: engine.subscribeCountIn,
  };
}
