import { useState, type KeyboardEvent, type Ref } from "react";
import type { InstrumentKind } from "@/generated/InstrumentKind";
import type { Row } from "@/generated/Row";
import { isBlackKey } from "@/lib/pianoRoll";

export function RowLabels({
  rows,
  kind = "drums",
  onAudition,
  ref,
}: {
  rows: Row[];
  kind?: InstrumentKind;
  onAudition?: (row: Row) => void;
  ref?: Ref<HTMLDivElement>;
}) {
  if (kind === "melodic") {
    return <Keyboard ref={ref} rows={rows} onAudition={onAudition} />;
  }

  return (
    <div ref={ref} className="sticky left-0 z-30 w-28 max-sm:w-20">
      {rows.map((row) => (
        <div
          key={row.id}
          title={row.name}
          style={{ height: "var(--row-h)" }}
          className="flex items-center border-r border-b border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-700 max-sm:px-2 max-sm:text-xs dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
        >
          <span className="line-clamp-2 sm:truncate">{row.name}</span>
        </div>
      ))}
    </div>
  );
}

const MIDDLE_C = 60;

// A single tab stop keeps 61 keys from standing between keyboard users and the grid.
function Keyboard({
  rows,
  onAudition,
  ref,
}: {
  rows: Row[];
  onAudition?: (row: Row) => void;
  ref?: Ref<HTMLDivElement>;
}) {
  const middleC = rows.findIndex((r) => r.midi_note === MIDDLE_C);
  const [active, setActive] = useState(Math.max(0, middleC));
  const current = Math.min(active, rows.length - 1);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = {
      ArrowUp: current - 1,
      ArrowDown: current + 1,
      Home: 0,
      End: rows.length - 1,
    };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const next = Math.min(rows.length - 1, Math.max(0, moves[e.key]));
    setActive(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-key-index="${next}"]`)?.focus();
  }

  const firstMidi = rows[0]?.midi_note ?? 0;

  return (
    <div
      ref={ref}
      onKeyDown={onKeyDown}
      style={{ height: `calc(var(--row-h) * ${rows.length})` }}
      className="sticky left-0 z-30 w-16 overflow-hidden border-r border-zinc-400 bg-[#d8d8d8] max-sm:w-14"
    >
      {rows.map((row, index) => {
        const black = isBlackKey(row.midi_note);
        const box = black
          ? { top: `calc(var(--row-h) * ${index})`, height: "var(--row-h)" }
          : whiteKeyBox(row.midi_note, firstMidi);
        return (
          <button
            key={row.id}
            type="button"
            data-key={black ? "black" : "white"}
            data-key-index={index}
            tabIndex={index === current ? 0 : -1}
            onFocus={() => setActive(index)}
            aria-label={row.name}
            onClick={() => onAudition?.(row)}
            style={box}
            className={`absolute left-0 cursor-pointer text-[10px] leading-none font-bold focus-visible:z-20 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-600 ${
              black
                ? "z-10 w-[58%] bg-[#1a1a1a] shadow-[inset_-1px_0_0_rgba(255,255,255,0.14)] hover:bg-[#3a3a3a]"
                : "flex w-full items-end justify-end border-b border-zinc-500 bg-[#dcdcdc] pr-1 pb-0.5 text-zinc-800 hover:bg-[#ececec]"
            }`}
          >
            {!black && row.midi_note % 12 === 0 ? row.name : null}
          </button>
        );
      })}
    </div>
  );
}

// Real keyboards split C-E across three white keys and F-B across four, so the E|F and B|C
// boundaries land on grid-row edges while the other white-key edges fall between rows.
const WHITE_GROUPS = [
  { lowPitchClass: 0, rowCount: 5, whites: [4, 2, 0] },
  { lowPitchClass: 5, rowCount: 7, whites: [11, 9, 7, 5] },
];

function whiteKeyBox(midiNote: number, firstMidi: number) {
  const pitchClass = midiNote % 12;
  const group = WHITE_GROUPS.find((g) => g.whites.includes(pitchClass))!;
  const count = group.whites.length;
  const groupTopMidi = midiNote - pitchClass + group.lowPitchClass + group.rowCount - 1;
  const numerator =
    (firstMidi - groupTopMidi) * count + group.whites.indexOf(pitchClass) * group.rowCount;
  return {
    top: `calc(var(--row-h) * ${numerator} / ${count})`,
    height: `calc(var(--row-h) * ${group.rowCount} / ${count})`,
  };
}
