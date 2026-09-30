"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useStoredHeight } from "@/lib/useStoredHeight";
import { HeightHandle } from "./HeightHandle";
import { PianoRoll } from "./PianoRoll";

const MIN_HEIGHT_PX = 160;
// Leaves room for the page chrome so the roll can't be dragged taller than the window can show.
const MAX_VIEWPORT_FRACTION = 0.9;

export function ResizablePianoRoll({
  storageKey,
  ...roll
}: ComponentProps<typeof PianoRoll> & { storageKey: string }) {
  const [stored, setStored] = useStoredHeight(storageKey);
  const wrapper = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);

  useEffect(() => {
    const el = wrapper.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setMeasured(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const max = Math.max(MIN_HEIGHT_PX, Math.round(window.innerHeight * MAX_VIEWPORT_FRACTION));
  const height = stored === null ? null : Math.min(max, Math.max(MIN_HEIGHT_PX, stored));

  return (
    <div
      ref={wrapper}
      className={height === null ? "" : "flex flex-col"}
      style={height === null ? undefined : { height }}
    >
      <PianoRoll {...roll} fillHeight={height !== null} />
      <HeightHandle
        label="Resize piano roll"
        value={height ?? Math.min(max, Math.max(MIN_HEIGHT_PX, measured))}
        min={MIN_HEIGHT_PX}
        max={max}
        grows="down"
        onChange={setStored}
        onReset={() => setStored(null)}
        className="rounded-b-xl"
      />
    </div>
  );
}
