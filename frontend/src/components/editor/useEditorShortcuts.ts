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

// Gutter keys sit inside the roll but must keep Space for their own audition.
const onKeyboardKey = (t: EventTarget | null) => t instanceof Element && t.closest("[data-key]") !== null;

export function useEditorShortcuts(instrumentId: string, onTogglePlayback?: () => void) {
  useShortcuts({
    togglePlayback: onTogglePlayback,
    undo: () => getPatternStore(instrumentId).getState().undo(),
    redo: () => getPatternStore(instrumentId).getState().redo(),
  });
}

interface ShortcutActions {
  togglePlayback?: () => void;
  undo: () => void;
  redo: () => void;
}

// Shared by the single-instrument pages and the Studio so the key rules cannot drift apart.
export function useShortcuts(actions: ShortcutActions) {
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isSpace(e) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.defaultPrevented || isTextEntryTarget(e.target) || onKeyboardKey(e.target)) return;
        const inRoll = insideRoll(e.target);
        if (!inRoll && e.target instanceof Element && e.target.closest(SELF_ACTIVATING)) return;
        e.preventDefault();
        if (!e.repeat) latest.current.togglePlayback?.();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // Text fields keep the browser's own text undo.
      if (isTextEditingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) latest.current.redo();
        else latest.current.undo();
      } else if (key === "y" && e.ctrlKey) {
        e.preventDefault();
        latest.current.redo();
      }
    };
    // Buttons fire click on Space keyup, which would toggle the focused cell.
    const onKeyUp = (e: KeyboardEvent) => {
      if (isSpace(e) && insideRoll(e.target) && !onKeyboardKey(e.target)) e.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, []);
}
