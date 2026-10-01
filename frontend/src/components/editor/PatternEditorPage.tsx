"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { MeasureCount } from "@/generated/MeasureCount";
import type { TimeSignature } from "@/generated/TimeSignature";
import { Button } from "@/components/ui/Button";
import { getPlaybackEngine } from "@/lib/audio/engine";
import { usePlayback } from "@/lib/audio/usePlayback";
import { beatSteps } from "@/lib/pianoRoll";
import { getInstruments, getLimits } from "@/lib/api";
import { gridOf } from "@/lib/patternOps";
import { getPatternStore, usePatternStore } from "@/lib/patternStore";
import { useApiResource } from "@/lib/useApiResource";
import { EditorToolbar } from "./EditorToolbar";
import { ErrorAlert } from "./ErrorAlert";
import { ResizablePianoRoll } from "./ResizablePianoRoll";
import { PromptForm } from "./PromptForm";
import { Transport } from "./Transport";
import { useEditorShortcuts } from "./useEditorShortcuts";

const card =
  "rounded-2xl border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-800 dark:bg-zinc-950";

const noopSubscribe = () => () => {};

export function PatternEditorPage({
  instrumentId,
  title,
  instrument: provided,
}: {
  instrumentId: string;
  title: string;
  // Lets a parent that already fetched the instrument avoid a first paint styled as drums.
  instrument?: InstrumentInfo;
}) {
  // localStorage only exists on the client, so server markup and first paint must not depend on it.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const pattern = usePatternStore(instrumentId, (s) => s.pattern);
  const instruments = useApiResource(getInstruments);
  const limits = useApiResource(getLimits);
  const [measures, setMeasures] = useState(4);
  const [timeSignature, setTimeSignature] = useState<TimeSignature>("4/4");
  const [status, setStatus] = useState("");
  const [follow, setFollow] = useState(true);
  const [inspectorSlot, setInspectorSlot] = useState<HTMLDivElement | null>(null);
  const loop = usePatternStore(instrumentId, (s) => s.loop);
  const playback = usePlayback(instrumentId, loop);

  const togglePlayback = () => {
    if (!pattern) return;
    if (!playback.isPlaying) setFollow(true);
    playback.toggle();
  };
  useEditorShortcuts(instrumentId, togglePlayback);

  const loadId = usePatternStore(instrumentId, (s) => s.loadId);
  const instrument = provided ?? instruments.data?.find((i) => i.id === instrumentId) ?? null;

  return (
    <main className="mx-auto flex w-full max-w-screen-2xl min-w-0 flex-1 flex-col gap-6 bg-zinc-50 px-4 py-6 text-zinc-900 sm:px-6 sm:py-8 dark:bg-black dark:text-zinc-50">
      <header>
        <nav aria-label="Breadcrumb" className="text-sm text-zinc-600 dark:text-zinc-400">
          <Link href="/" className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-black dark:focus-visible:outline-white">
            Songbird
          </Link>{" "}
          <span aria-hidden="true">›</span>
        </nav>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-zinc-600 dark:text-zinc-400">Describe a groove, then shape it on the grid.</p>
      </header>

      {hydrated ? (
        <PromptForm
        instrumentId={instrumentId}
        limits={limits.data}
        limitsState={limits.status}
        onRetryLimits={limits.retry}
        measures={measures}
        onMeasuresChange={setMeasures}
        timeSignature={timeSignature}
        onTimeSignatureChange={setTimeSignature}
        onGenerated={(p, hadPrevious) =>
          setStatus(
            `Generated "${p.name}".${hadPrevious ? " Undo to get your previous pattern back." : ""}`,
          )
        }
        />
      ) : (
        <div aria-hidden="true" className={`${card} h-72 motion-safe:animate-pulse`} />
      )}

      <section aria-label="Editor" className={`${card} flex min-w-0 flex-col gap-4`}>
        <p role="status" className="min-h-5 text-sm text-zinc-600 dark:text-zinc-400">
          {status}
        </p>
        {!hydrated ? (
          <div aria-hidden="true" className="flex flex-col gap-2">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="h-8 rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-900" />
            ))}
          </div>
        ) : !pattern ? (
          <div className="flex flex-col items-start gap-3">
            <h2 className="text-lg font-semibold">No pattern yet</h2>
            <p className="text-zinc-600 dark:text-zinc-400">
              Describe a groove above, or start from a blank grid.
            </p>
            {instruments.status === "error" && (
              <ErrorAlert message={`Couldn't load the rows for ${title}.`} onRetry={instruments.retry} />
            )}
            <Button
              disabled={!instrument}
              onClick={() =>
                instrument &&
                getPatternStore(instrumentId)
                  .getState()
                  .newEmptyPattern(instrument, measures as MeasureCount, timeSignature)
              }
            >
              Start with a blank grid
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-base font-semibold">{pattern.name}</h2>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-xs dark:bg-zinc-800">
                {pattern.time_signature}
              </span>
            </div>
            <Transport
              playback={playback}
              onToggle={togglePlayback}
              stepsPerMeasure={pattern.steps_per_measure}
              beatSteps={beatSteps(pattern.time_signature)}
              loop={loop}
              onLoopChange={(l) => getPatternStore(instrumentId).getState().setLoop(l)}
              follow={follow}
              onFollowChange={setFollow}
            />
            <EditorToolbar
              instrumentId={instrumentId}
              instrument={instrument}
              pattern={pattern}
              measureOptions={limits.data?.measure_options ?? null}
              onStatus={setStatus}
            />
            <div ref={setInspectorSlot} />
            <ResizablePianoRoll
              storageKey={`songbird.editor.${instrumentId}.rollHeight`}
              instrumentName={instrument?.name ?? "Instrument"}
              kind={instrument?.kind}
              sustained={instrument?.sustained}
              onAudition={(row) => void getPlaybackEngine(instrumentId).audition(row)}
              grid={gridOf(pattern)}
              timeSignature={pattern.time_signature}
              stepsPerMeasure={pattern.steps_per_measure}
              resetKey={loadId}
              onToggleNote={(rowId, step, len) => getPatternStore(instrumentId).getState().toggleNote(rowId, step, len)}
              onSetVelocity={(rowId, step, v) => getPatternStore(instrumentId).getState().setVelocity(rowId, step, v)}
              onResizeNote={(rowId, step, len) => getPatternStore(instrumentId).getState().resizeNote(rowId, step, len)}
              onEditNotes={(fn, options) => getPatternStore(instrumentId).getState().editNotes(fn, options)}
              onBeginGesture={() => getPatternStore(instrumentId).getState().beginGesture()}
              onEndGesture={() => getPatternStore(instrumentId).getState().commitGesture()}
              onCancelGesture={() => getPatternStore(instrumentId).getState().cancelGesture()}
              inspectorTarget={inspectorSlot}
              onAnnounce={setStatus}
              onPlaceNote={(row, velocity) => void getPlaybackEngine(instrumentId).audition(row, { velocity })}
              loop={loop}
              onLoopChange={(l) => getPatternStore(instrumentId).getState().setLoop(l)}
              follow={follow}
              isPlaying={playback.isPlaying}
              onManualScroll={() => setFollow(false)}
              subscribePosition={playback.subscribePosition}
            />
          </>
        )}
      </section>
    </main>
  );
}
