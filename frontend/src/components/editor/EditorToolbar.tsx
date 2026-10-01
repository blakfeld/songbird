"use client";

import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { MeasureCount } from "@/generated/MeasureCount";
import type { Pattern } from "@/generated/Pattern";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { getPatternStore, usePatternStore } from "@/lib/patternStore";
import { DownloadMidiButton } from "./DownloadMidiButton";
import { NewPatternDialog } from "./NewPatternDialog";
import { SendToSongButton } from "./SendToSongButton";
import { SwingSlider } from "./SwingSlider";
import { TempoField } from "./TempoField";

const divider = "sm:border-l sm:border-zinc-200 sm:pl-6 dark:sm:border-zinc-800";

export function EditorToolbar({
  instrumentId,
  instrument,
  pattern,
  measureOptions,
  onStatus,
  guardEdit = (edit) => edit(),
}: {
  instrumentId: string;
  instrument: InstrumentInfo | null;
  pattern: Pattern;
  measureOptions: number[] | null;
  onStatus: (message: string) => void;
  // Ends a running take before the history moves, so the take's notes are not lost to the undo.
  guardEdit?: (edit: () => void) => void;
}) {
  const canUndo = usePatternStore(
    instrumentId,
    // A take or drag in flight has no history entry yet, but undo still works because it commits that gesture first.
    (s) => s.past.length > 0 || (s.gestureBase !== null && s.gestureBase !== s.pattern),
  );
  const canRedo = usePatternStore(instrumentId, (s) => s.future.length > 0);
  const actions = () => getPatternStore(instrumentId).getState();

  return (
    <div
      role="toolbar"
      aria-label="Pattern"
      className="flex flex-wrap items-center gap-x-6 gap-y-3"
    >
      <div className="flex items-center gap-2">
        <label htmlFor="toolbar-measures" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Measures
        </label>
        <Select
          id="toolbar-measures"
          value={pattern.measures}
          disabled={measureOptions === null}
          onChange={(e) => actions().setMeasures(Number(e.target.value) as MeasureCount)}
        >
          {(measureOptions ?? [pattern.measures]).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      </div>
      <TempoField value={pattern.tempo_bpm} onCommit={(bpm) => actions().setTempo(bpm)} />
      <SwingSlider value={pattern.swing} onCommit={(s) => actions().setSwing(s)} />
      <div className={`flex items-center gap-2 ${divider}`}>
        <Button
          aria-label="Undo"
          title="Undo (⌘Z / Ctrl+Z)"
          aria-keyshortcuts="Meta+Z Control+Z"
          disabled={!canUndo}
          onClick={() => guardEdit(() => actions().undo())}
        >
          <span aria-hidden="true">↶</span>
          <span className="max-sm:hidden">Undo</span>
        </Button>
        <Button
          aria-label="Redo"
          title="Redo (⇧⌘Z / Ctrl+Shift+Z)"
          aria-keyshortcuts="Shift+Meta+Z Shift+Control+Z"
          disabled={!canRedo}
          onClick={() => guardEdit(() => actions().redo())}
        >
          <span aria-hidden="true">↷</span>
          <span className="max-sm:hidden">Redo</span>
        </Button>
      </div>
      <div className={`flex items-center gap-2 ${divider}`}>
        <Button
          disabled={pattern.notes.length === 0}
          onClick={() => {
            actions().clear();
            onStatus("Pattern cleared. Undo to restore.");
          }}
        >
          Clear
        </Button>
        <NewPatternDialog
          instrument={instrument}
          defaultMeasures={pattern.measures}
          defaultTimeSignature={pattern.time_signature}
          measureOptions={measureOptions ?? [pattern.measures]}
          onCreate={(m, ts) => {
            if (instrument) actions().newEmptyPattern(instrument, m, ts);
            onStatus("Created a new empty pattern.");
          }}
        />
      </div>
      <div className={divider}>
        <SendToSongButton pattern={pattern} />
      </div>
      <div className={divider}>
        <DownloadMidiButton pattern={pattern} onExported={(f) => onStatus(`Saved ${f}.`)} />
      </div>
    </div>
  );
}
