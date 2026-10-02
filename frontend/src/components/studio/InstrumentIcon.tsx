import type { InstrumentKind } from "@/generated/InstrumentKind";

const glyphs: Record<string, React.ReactNode> = {
  drums: (
    <>
      <ellipse cx="10" cy="8" rx="6" ry="2.5" />
      <path d="M4 8v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V8M7 4l-2-2M13 4l2-2" />
    </>
  ),
  piano: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <path d="M7 4v7M10 4v7M13 4v7M5.5 11h9" />
    </>
  ),
  bass: <path d="M3 10c2-5 3-5 4 0s2 5 4 0 2-5 4 0" />,
  synth: <path d="M3 13l3-6 3 6 3-6 3 6M3 16h14" />,
  strings: <path d="M6 3v14M10 3v14M14 3v14M4 6c4 2 8 2 12 0" />,
  audio: <path d="M3 10h1M6 7v6M9 4v12M12 6v8M15 8v4M17 10h0" />,
  "sampler-keys": <path d="M3 5h14v10H3zM7 5v6M11 5v6M15 5v6M3 3l3 1 3-2 3 2 3-1 2 1" />,
  "sampler-pads": <path d="M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z" />,
  note: (
    <>
      <circle cx="7" cy="14" r="2.5" />
      <path d="M9.5 14V4l6 1.5" />
    </>
  ),
};

function glyphFor(instrumentId: string | null, kind: InstrumentKind | null) {
  if (instrumentId && instrumentId in glyphs) return glyphs[instrumentId];
  if (kind === "drums") return glyphs.drums;
  return glyphs.note;
}

// The glyph is decoration: the instrument name is always shown as text beside it.
export function InstrumentIcon({
  instrumentId,
  kind,
  missing = false,
  className = "",
}: {
  instrumentId: string | null;
  kind: InstrumentKind | null;
  missing?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 ${className}`}
    >
      {missing ? (
        <span className="text-sm font-bold">?</span>
      ) : (
        <svg
          viewBox="0 0 20 20"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {glyphFor(instrumentId, kind)}
        </svg>
      )}
    </span>
  );
}
