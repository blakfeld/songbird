"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Spinner } from "@/components/ui/Spinner";
import type { PadSettings } from "@/generated/PadSettings";
import type { Row } from "@/generated/Row";
import { useSampleMissing } from "@/lib/audio/useSampleMissing";
import { PAD_COUNT } from "@/lib/song/sampler";
import type { Song, Track } from "@/lib/song/types";
import { loopColour } from "../loopPalette";
import { AnchoredPopover } from "../AnchoredPopover";
import { useDragActive } from "../samples/useSampleDrop";
import { decibels, semitones } from "../TrackSoundPanel";
import type { SamplerActions, SamplerImporting } from "../useSamplerActions";
import { DragTip } from "./DragTip";
import { PadSettingsPanel } from "./PadSettings";
import { useSamplerDrop } from "./useSamplerDrop";

export const PAD_LABELS_HELP_ID = "pad-labels-help";
const HELP =
  "Up and Down move between pads. Enter plays the pad. Shift F10 or the settings button opens the pad's sample, preview, clear, gain and pitch. Delete clears the pad.";

const swatch = "size-3 shrink-0 rounded-sm";

const spokenSigned = (n: number, unit: string, unitPlural = unit) =>
  `${n < 0 ? "minus" : "plus"} ${Math.abs(n)} ${Math.abs(n) === 1 ? unit : unitPlural}`;

function tuning(pad: PadSettings | undefined) {
  if (!pad) return { title: "", spoken: undefined as string | undefined };
  const parts: string[] = [];
  const spoken: string[] = [];
  if (pad.gain_db !== 0) {
    parts.push(decibels(pad.gain_db));
    spoken.push(`gain ${spokenSigned(Number(pad.gain_db.toFixed(1)), "decibel", "decibels")}`);
  }
  if (pad.pitch_semitones !== 0) {
    parts.push(semitones(pad.pitch_semitones));
    spoken.push(`pitch ${spokenSigned(pad.pitch_semitones, "semitone", "semitones")}`);
  }
  return { title: parts.join(" · "), spoken: spoken.length ? spoken.join(", ") : undefined };
}

interface RowProps {
  song: Song;
  track: Track;
  row: Row;
  index: number;
  tabbable: boolean;
  actions: SamplerActions;
  importing: SamplerImporting | null;
  dragActive: boolean;
  menuOpen: boolean;
  onFocusRow: (index: number) => void;
  onOpenMenu: (index: number, anchor: { x: number; y: number }, opener: "label" | "more") => void;
}

function PadRow({ song, track, row, index, tabbable, actions, importing, dragActive, menuOpen, onFocusRow, onOpenMenu }: RowProps) {
  const pad = track.sampler?.pads?.find((p) => p.row_id === row.id);
  const sample = pad ? (song.samples ?? []).find((s) => s.id === pad.sample_id) : undefined;
  const colourIndex = pad ? (song.samples ?? []).findIndex((s) => s.id === pad.sample_id) : -1;
  const missing = useSampleMissing(pad?.sample_id ?? null);
  const name = sample?.name ?? "the sample";
  const busy = importing !== null && importing.trackId === track.id && importing.rowIds.includes(row.id);

  const { hover, props } = useSamplerDrop({
    single: false,
    onDrop: (payload) => {
      if (payload.kind === "sample") actions.assignPads(track.id, row.id, [payload.entry], "library");
      else actions.importDropped({ trackId: track.id, rowId: row.id }, payload.files);
    },
  });

  const { title: tune, spoken } = tuning(pad);
  const state = !pad ? "empty" : missing ? "missing" : "ready";
  const label = !pad ? `${row.name}, empty` : missing ? `${row.name}, ${name}, audio missing` : `${row.name}, ${name}`;
  const lastPad = Math.min(PAD_COUNT, index + (hover?.fileCount ?? 1));
  const tip = hover
    ? hover.invalid
      ? `⊘ ${hover.invalid}`
      : hover.kind === "sample"
        ? `${hover.name ?? "Sample"} → ${row.name}`
        : hover.fileCount > 1
          ? `${hover.fileCount} files → Pads ${index + 1}–${lastPad}`
          : `Import → ${row.name}`
    : null;
  const ring = hover
    ? hover.invalid
      ? "ring-2 ring-inset ring-red-700 dark:ring-red-400"
      : "ring-2 ring-inset ring-indigo-600 bg-indigo-50 dark:ring-indigo-400 dark:bg-indigo-950/40"
    : dragActive
      ? "ring-1 ring-inset ring-indigo-600/40 dark:ring-indigo-400/40"
      : "";
  const shown = hover && !hover.invalid && hover.kind === "sample" && hover.name;
  const visible = shown ? (pad ? `${name} → ${hover.name}` : hover.name) : busy ? `Importing… ${Math.round(importing.percent)}%` : state === "empty" ? row.name : state === "missing" ? `⚠ ${name}` : name;

  return (
    <div
      data-pad-row={row.id}
      aria-busy={busy || undefined}
      style={{ height: "var(--row-h)" }}
      {...props}
      onContextMenu={(e) => {
        e.preventDefault();
        onOpenMenu(index, { x: e.clientX, y: e.clientY }, "label");
      }}
      className={`group/pad relative flex items-center border-r border-b border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950 ${ring}`}
    >
      {/* The description rides on the button like the piano keys' does, since the name must stay the pad's own. */}
      {/* eslint-disable-next-line jsx-a11y/role-supports-aria-props */}
      <button
        type="button"
        data-pad-label
        data-pad-index={index}
        tabIndex={tabbable ? 0 : -1}
        aria-label={label}
        aria-description={spoken}
        aria-keyshortcuts="Shift+F10 Delete"
        aria-describedby={PAD_LABELS_HELP_ID}
        title={pad ? `${row.name} · ${name}${tune ? ` · ${tune}` : ""}` : `${row.name} · empty · drop a sample here`}
        onFocus={() => onFocusRow(index)}
        onClick={() => actions.audition(track.id, row)}
        className="flex h-full min-w-0 flex-1 items-center gap-2 pr-1 pl-3 text-left text-sm hover:bg-zinc-100 focus-visible:z-20 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-600 max-sm:pl-2 max-sm:text-xs dark:hover:bg-zinc-900"
      >
        {busy ? (
          <span className="shrink-0 text-indigo-700 dark:text-indigo-300">
            <Spinner />
          </span>
        ) : (
          <span
            aria-hidden="true"
            className={
              state === "empty"
                ? `${swatch} border border-dashed border-zinc-400 dark:border-zinc-600`
                : state === "missing"
                  ? `${swatch} border border-dashed border-red-700 dark:border-red-400`
                  : `${swatch} ${loopColour(Math.max(0, colourIndex)).swatch}`
            }
          />
        )}
        <span
          className={`min-w-0 truncate ${
            hover?.invalid
              ? "font-medium text-red-800 dark:text-red-300"
              : state === "empty"
                ? "font-normal text-zinc-600 dark:text-zinc-400"
                : state === "missing"
                  ? "font-medium text-red-800 dark:text-red-300"
                  : "font-medium text-zinc-900 dark:text-zinc-100"
          } ${shown ? "italic" : ""}`}
        >
          {hover?.invalid ? `⊘ ${visible}` : visible}
        </span>
      </button>
      <button
        type="button"
        data-pad-more
        tabIndex={-1}
        aria-label={`${row.name} settings`}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        onFocus={() => onFocusRow(index)}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onOpenMenu(index, { x: rect.left, y: rect.bottom }, "more");
        }}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black pointer-coarse:size-9 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50 dark:focus-visible:outline-white"
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {tip && <DragTip text={tip} className="top-1/2 left-full ml-1 -translate-y-1/2" />}
    </div>
  );
}

// Stands in for the piano roll's own label column on a pads track, so a pad's sample is named and assigned where its notes are.
export function PadRowLabels({
  rows,
  gutterClassName,
  song,
  track,
  actions,
  importing,
}: {
  rows: Row[];
  gutterClassName?: string;
  song: Song;
  track: Track;
  actions: SamplerActions;
  importing: SamplerImporting | null;
}) {
  const [active, setActive] = useState(0);
  const [menu, setMenu] = useState<{ index: number; anchor: { x: number; y: number }; opener: "label" | "more" } | null>(null);
  const dragActive = useDragActive();
  const box = useRef<HTMLDivElement>(null);
  const current = Math.min(active, rows.length - 1);

  const focusPad = (index: number, part: "label" | "more" = "label") =>
    box.current
      ?.querySelector<HTMLElement>(`[data-pad-row="${rows[index]?.id}"] [data-pad-${part}]`)
      ?.focus();

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The settings popover is portalled but React still bubbles its keys here, and they belong to its own controls.
    if (!box.current?.contains(e.target as Node)) return;
    const target = e.target as HTMLElement;
    const onLabel = target.hasAttribute("data-pad-label");
    const onMore = target.hasAttribute("data-pad-more");
    if (!onLabel && !onMore) return;
    const row = rows[current];
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const next =
        e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, current + (e.key === "ArrowDown" ? 1 : -1)));
      setActive(next);
      focusPad(next, onMore ? "more" : "label");
    } else if (e.key === "ArrowRight" && onLabel) {
      e.preventDefault();
      focusPad(current, "more");
    } else if (e.key === "ArrowLeft" && onMore) {
      e.preventDefault();
      focusPad(current, "label");
    } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      const rect = target.getBoundingClientRect();
      setMenu({ index: current, anchor: { x: rect.left, y: rect.bottom }, opener: onMore ? "more" : "label" });
    } else if ((e.key === "Delete" || e.key === "Backspace") && onLabel && row) {
      e.preventDefault();
      actions.clearPad(track.id, row.id);
    }
  };

  const menuRow = menu ? rows[menu.index] : undefined;
  const menuPad = menuRow ? track.sampler?.pads?.find((p) => p.row_id === menuRow.id) : undefined;
  const menuSample = menuPad ? (song.samples ?? []).find((s) => s.id === menuPad.sample_id) : undefined;

  return (
    <div
      ref={box}
      role="group"
      aria-label={`${track.name} pads`}
      onKeyDown={onKeyDown}
      className={`sticky left-0 z-30 ${gutterClassName ?? "w-28 max-sm:w-20"}`}
    >
      <p id={PAD_LABELS_HELP_ID} className="sr-only">
        {HELP}
      </p>
      {rows.map((row, index) => (
        <PadRow
          key={row.id}
          song={song}
          track={track}
          row={row}
          index={index}
          tabbable={index === current}
          actions={actions}
          importing={importing}
          dragActive={dragActive}
          menuOpen={menu?.index === index}
          onFocusRow={setActive}
          onOpenMenu={(i, anchor, opener) => setMenu((m) => (m?.index === i && m.opener === opener ? null : { index: i, anchor, opener }))}
        />
      ))}
      {menu && menuRow && (
        <PadMenu
          key={`${menuRow.id}-${menu.opener}`}
          open
          anchor={menu.anchor}
          song={song}
          track={track}
          row={menuRow}
          pad={menuPad}
          sample={menuSample}
          actions={actions}
          opener={menu.opener}
          returnFocus={() => box.current?.querySelector<HTMLElement>(`[data-pad-row="${menuRow.id}"] [data-pad-${menu.opener}]`) ?? null}
          onClose={() => setMenu(null)}
          onChoose={() => {
            const invoker = box.current?.querySelector<HTMLElement>(`[data-pad-row="${menuRow.id}"] [data-pad-label]`) ?? null;
            setMenu(null);
            actions.requestPick({ trackId: track.id, rowId: menuRow.id }, invoker);
          }}
        />
      )}
    </div>
  );
}

function PadMenu({
  open,
  anchor,
  track,
  row,
  pad,
  sample,
  actions,
  opener,
  returnFocus,
  onClose,
  onChoose,
}: {
  open: boolean;
  anchor: { x: number; y: number };
  song: Song;
  track: Track;
  row: Row;
  pad: PadSettings | undefined;
  sample: import("@/generated/Sample").Sample | undefined;
  actions: SamplerActions;
  opener: "label" | "more";
  returnFocus: () => HTMLElement | null;
  onClose: () => void;
  onChoose: () => void;
}) {
  const missing = useSampleMissing(pad?.sample_id ?? null);
  return (
    <AnchoredPopover
      open={open}
      anchor={anchor}
      label={pad ? `${row.name}: ${sample?.name ?? "sample"}` : `${row.name}: empty`}
      onClose={onClose}
      returnFocusTo={returnFocus}
      // Only the settings button counts as inside: a right-click or key opener is dismissed by pressing anywhere else.
      anchorElement={() => (opener === "more" ? returnFocus() : null)}
    >
      <PadSettingsPanel
        trackId={track.id}
        row={row}
        pad={pad}
        sample={sample}
        missing={missing}
        actions={actions}
        onChoose={onChoose}
        onClear={() => {
          actions.clearPad(track.id, row.id);
          requestAnimationFrame(() => returnFocus()?.focus());
        }}
        onClose={onClose}
      />
    </AnchoredPopover>
  );
}
