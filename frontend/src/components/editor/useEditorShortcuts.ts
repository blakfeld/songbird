"use client";

import { useEffect, useRef } from "react";
import { getPatternStore } from "@/lib/patternStore";
import { isTextEditingTarget, isTextEntryTarget } from "@/lib/pianoRoll";

const ROLL = '[aria-roledescription="piano roll"]';
// Space already activates these natively; toggling playback as well would double-fire.
const SELF_ACTIVATING = 'button, a[href], summary, input[type="checkbox"], input[type="radio"]';

const isSpace = (e: KeyboardEvent) => e.key === " " || e.code === "Space";

// Inside the roll Space is playback, not "press the focused cell".
const insideRoll = (t: EventTarget | null) => t instanceof Element && t.closest(ROLL) !== null;

export function useEditorShortcuts(instrumentId: string, onTogglePlayback?: () => void) {
  const toggle = useRef(onTogglePlayback);
  useEffect(() => {
    toggle.current = onTogglePlayback;
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isSpace(e) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.defaultPrevented || isTextEntryTarget(e.target)) return;
        const inRoll = insideRoll(e.target);
        if (!inRoll && e.target instanceof Element && e.target.closest(SELF_ACTIVATING)) return;
        e.preventDefault();
        if (!e.repeat) toggle.current?.();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // Text fields keep the browser's own text undo.
      if (isTextEditingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      const store = getPatternStore(instrumentId).getState();
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (key === "y" && e.ctrlKey) {
        e.preventDefault();
        store.redo();
      }
    };
    // Buttons fire click on Space keyup, which would toggle the focused cell.
    const onKeyUp = (e: KeyboardEvent) => {
      if (isSpace(e) && insideRoll(e.target)) e.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [instrumentId]);
}
