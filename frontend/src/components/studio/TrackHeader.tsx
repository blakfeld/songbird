"use client";

import { useState } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import { focusRing } from "@/components/ui/classes";
import { TRACK_NAME_MAX, type Song, type Track } from "@/lib/song/types";
import { LaneMenuItems, defaultLaneMeasure } from "./ClipMenu";
import { InlineNameInput } from "./InlineNameInput";
import { InstrumentIcon } from "./InstrumentIcon";
import { Menu, menuItemClass } from "./Menu";
import { PanKnob } from "./PanKnob";
import { Spinner } from "@/components/ui/Spinner";
import type { TrackActions } from "./trackActions";
import type { ClipActions } from "./useClipActions";
import { VolumeSlider } from "./VolumeSlider";

const toggleBase = `size-7 shrink-0 rounded text-xs font-bold pointer-coarse:size-9 ${focusRing}`;
const toggleOff =
  "border border-zinc-300 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300";

export type InstrumentLookup =
  | { state: "loading" }
  | { state: "ready"; info: InstrumentInfo }
  | { state: "missing" };

export function TrackHeader({
  song,
  track,
  number,
  selected,
  instrument,
  actions,
  selectedClipId,
  clipActions,
  generating,
  generateBlocked,
}: {
  song: Song;
  track: Track;
  number: number;
  selected: boolean;
  instrument: InstrumentLookup;
  actions: TrackActions;
  selectedClipId: string | null;
  clipActions: ClipActions;
  generating: boolean;
  // Only one generation runs per song, so the others wait for it.
  generateBlocked: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const info = instrument.state === "ready" ? instrument.info : null;
  const instrumentName =
    instrument.state === "missing" ? "Instrument unavailable" : (info?.name ?? track.instrument);
  const showInstrument = instrument.state === "missing" || info?.name !== track.name;

  return (
    <div
      className={`flex min-w-0 flex-col gap-1 border-r border-zinc-200 px-2 py-1.5 max-md:gap-1.5 dark:border-zinc-800 ${
        selected
          ? "bg-indigo-50 shadow-[inset_4px_0_0] shadow-indigo-600 dark:bg-indigo-950/40"
          : "bg-white dark:bg-zinc-950"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-5 shrink-0 text-right font-mono text-xs text-zinc-600 tabular-nums dark:text-zinc-400">
          {number}
        </span>
        <InstrumentIcon
          instrumentId={track.instrument}
          kind={info?.kind ?? null}
          missing={instrument.state === "missing"}
          className="max-md:hidden"
        />
        {renaming ? (
          <InlineNameInput
            value={track.name}
            label={`Track name ${track.name}`}
            maxLength={TRACK_NAME_MAX}
            className="h-8 flex-1"
            onCommit={(name) => {
              actions.rename(track.id, name);
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <button
            type="button"
            aria-label={`Select ${track.name} track (${instrumentName})`}
            data-track-select={track.id}
            aria-current={selected ? "true" : undefined}
            onClick={() => actions.select(track.id)}
            onDoubleClick={() => setRenaming(true)}
            className={`min-w-0 flex-1 rounded text-left ${focusRing}`}
          >
            <span className="block truncate text-sm font-medium">{track.name}</span>
            {generating ? (
              <span className="flex items-center gap-1 text-xs text-indigo-700 dark:text-indigo-300">
                <Spinner />
                Generating…
              </span>
            ) : (
              showInstrument && (
                <span className="block truncate text-xs text-zinc-600 dark:text-zinc-400">
                  {instrumentName}
                </span>
              )
            )}
          </button>
        )}
        <Menu
          label={`Track options for ${track.name}`}
          align="right"
          panelClassName="w-64"
          triggerClassName={`inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-zinc-100 pointer-coarse:size-9 dark:hover:bg-zinc-800 ${focusRing}`}
          trigger={<span aria-hidden="true">⋯</span>}
        >
          {(close) => (
            <LaneMenuItems
              track={track}
              measure={defaultLaneMeasure(song, track, selectedClipId)}
              actions={clipActions}
              close={close}
              extra={
              <>
              <button
                type="button"
                role="menuitem"
                aria-disabled={generating || generateBlocked}
                aria-describedby={generating || generateBlocked ? `${track.id}-generate-hint` : undefined}
                className={menuItemClass}
                onClick={() => {
                  if (generating || generateBlocked) return;
                  close();
                  actions.generate(track.id);
                }}
              >
                Generate part with AI…
              </button>
              {(generating || generateBlocked) && (
                <p id={`${track.id}-generate-hint`} className="px-3 pb-2 text-xs text-zinc-600 dark:text-zinc-400">
                  {generating ? "Already generating this track" : "Another track is generating"}
                </p>
              )}
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  close();
                  setRenaming(true);
                }}
              >
                Rename track…
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  close();
                  actions.remove(track.id);
                }}
              >
                Delete track
              </button>
              </>
              }
            />
          )}
        </Menu>
      </div>
      <div className="flex items-center gap-2 pl-7 max-md:pl-0">
        <button
          type="button"
          aria-label={`Mute ${track.name}`}
          aria-pressed={track.muted}
          onClick={() => actions.mixer(track.id, { muted: !track.muted })}
          className={`${toggleBase} ${track.muted ? "bg-indigo-600 text-white dark:bg-indigo-400 dark:text-zinc-950" : toggleOff}`}
        >
          M
        </button>
        <button
          type="button"
          aria-label={`Solo ${track.name}`}
          aria-pressed={track.soloed}
          onClick={() => actions.mixer(track.id, { soloed: !track.soloed })}
          className={`${toggleBase} ${track.soloed ? "bg-amber-400 text-zinc-950" : toggleOff}`}
        >
          S
        </button>
        <VolumeSlider
          name={track.name}
          value={track.volume_db}
          onChange={(db, o) => actions.mixer(track.id, { volume_db: db }, o)}
          onGestureStart={actions.beginGesture}
          onGestureEnd={actions.endGesture}
        />
        <PanKnob
          name={track.name}
          value={track.pan}
          onChange={(pan, o) => actions.mixer(track.id, { pan }, o)}
          onGestureStart={actions.beginGesture}
          onGestureEnd={actions.endGesture}
        />
      </div>
    </div>
  );
}
