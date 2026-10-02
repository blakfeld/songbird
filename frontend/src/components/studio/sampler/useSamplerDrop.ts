"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { draggedSample, dragKind, readDrop, type DropPayload } from "../samples/useSampleDrop";

export interface DropHover {
  kind: "sample" | "files";
  // Library drags carry the sample's name because the drop data is unreadable until it lands.
  name: string | null;
  fileCount: number;
  // Why the drop would be refused, shown in the tip so the refusal is not only a red ring.
  invalid: string | null;
}

// Types are only readable during a drag, and only for files; a file with no type is unknown rather than wrong,
// so it is let through and the importer reports it if it really is not audio.
export function classifyDrag(dt: DataTransfer | null, single: boolean): DropHover | null {
  const kind = dragKind(dt);
  if (!kind || !dt) return null;
  if (kind === "sample") return { kind, name: draggedSample()?.name ?? null, fileCount: 1, invalid: null };
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === "file");
  const types = items.map((i) => i.type).filter((t) => t !== "");
  if (types.length > 0 && types.every((t) => !t.startsWith("audio/")))
    return { kind, name: null, fileCount: items.length, invalid: "Not an audio file" };
  if (single && items.length > 1) return { kind, name: null, fileCount: items.length, invalid: "Drop one sample" };
  return { kind, name: null, fileCount: items.length, invalid: null };
}

// Shared by the keys strip and every pad label so the three agree on what may be dropped and how it is shown.
export function useSamplerDrop({
  single,
  onDrop,
}: {
  single: boolean;
  onDrop: (payload: DropPayload) => void;
}) {
  const [hover, setHover] = useState<DropHover | null>(null);
  const latest = useRef(onDrop);
  useEffect(() => {
    latest.current = onDrop;
  });

  const props = {
    onDragOver(e: DragEvent) {
      const next = classifyDrag(e.dataTransfer, single);
      if (!next) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = next.invalid ? "none" : "copy";
      setHover((h) =>
        h && h.kind === next.kind && h.name === next.name && h.fileCount === next.fileCount && h.invalid === next.invalid
          ? h
          : next,
      );
    },
    onDragLeave(e: DragEvent) {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(null);
    },
    onDrop(e: DragEvent) {
      const refused = classifyDrag(e.dataTransfer, single)?.invalid;
      if (!dragKind(e.dataTransfer)) return;
      e.preventDefault();
      setHover(null);
      if (refused) return;
      void readDrop(e.dataTransfer).then((payload) => payload && latest.current(payload));
    },
  };
  return { hover, props };
}
