"use client";

import { useEffect, useState } from "react";
import { getLibraryEntry, type SampleLibraryEntry } from "@/lib/audio/sampleLibrary";

export const SAMPLE_MIME = "application/x-songbird-sample";

// dataTransfer contents are unreadable during dragover, so the dragged row is remembered to draw a ghost of the right size.
let dragged: SampleLibraryEntry | null = null;
export const draggedSample = () => dragged;

export function beginSampleDrag(e: React.DragEvent, entry: SampleLibraryEntry) {
  dragged = entry;
  e.dataTransfer.setData(SAMPLE_MIME, entry.id);
  e.dataTransfer.effectAllowed = "copy";
}

export const endSampleDrag = () => {
  dragged = null;
};

export type DropPayload = { kind: "sample"; entry: SampleLibraryEntry } | { kind: "files"; files: File[] };

export function dragKind(dt: DataTransfer | null): "sample" | "files" | null {
  const types = dt ? Array.from(dt.types ?? []) : [];
  if (types.includes(SAMPLE_MIME)) return "sample";
  if (types.includes("Files")) return "files";
  return null;
}

export async function readDrop(dt: DataTransfer): Promise<DropPayload | null> {
  const id = dt.getData?.(SAMPLE_MIME);
  if (id) {
    const entry = dragged?.id === id ? dragged : await getLibraryEntry(id);
    return entry ? { kind: "sample", entry } : null;
  }
  const files = Array.from(dt.files ?? []);
  return files.length > 0 ? { kind: "files", files } : null;
}

// Window-level so lanes light up as soon as a drag enters the page, not only once it is over one.
export function useDragActive(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    // dragenter and dragleave fire in pairs across child elements, so a depth count tells when the page was left.
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!dragKind(e.dataTransfer)) return;
      depth++;
      setActive(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };
    const end = () => {
      depth = 0;
      setActive(false);
      endSampleDrag();
    };
    // Without this a file dropped a few pixels off a target makes the browser navigate to it and lose the session.
    const over = (e: DragEvent) => {
      if (dragKind(e.dataTransfer) !== "files" || e.defaultPrevented) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    const drop = (e: DragEvent) => {
      if (dragKind(e.dataTransfer) === "files") e.preventDefault();
      end();
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragend", end);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragend", end);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);
  return active;
}

export interface SampleDrop {
  active: boolean;
  // Null stands for the below-the-lanes zone, where the track does not exist until the drop is accepted.
  onDrop: (trackId: string | null, startTicks: number, free: boolean, payload: DropPayload) => void;
}
