// One place for the status-region wording so Studio and single-instrument takes announce identically.
export const COUNT_IN_STARTED = "Count-in. Recording starts after one bar.";
export const COUNT_IN_CANCELLED = "Count-in cancelled. Nothing was recorded.";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const takeStartedMessage = (bar: number) => `Recording from bar ${bar}.`;

export function takeEndedMessage(
  notes: number,
  dropped: { clipLimit?: number; loopLimit?: number; noRoom?: number } = {},
) {
  const parts = [
    notes > 0
      ? `Recorded ${plural(notes, "note")}. Undo removes the take.`
      : "Take ended. No notes recorded.",
  ];
  if (dropped.clipLimit) {
    parts.push(
      `${plural(dropped.clipLimit, "note")} ${dropped.clipLimit === 1 ? "wasn't" : "weren't"} recorded because the song has the most clips it can hold.`,
    );
  }
  if (dropped.loopLimit) {
    parts.push(
      `${plural(dropped.loopLimit, "note")} ${dropped.loopLimit === 1 ? "wasn't" : "weren't"} recorded because the song has the most loops it can hold.`,
    );
  }
  if (dropped.noRoom) {
    parts.push(
      `${plural(dropped.noRoom, "note")} ${dropped.noRoom === 1 ? "wasn't" : "weren't"} recorded because there was no room for a new clip.`,
    );
  }
  return parts.join(" ");
}

// MIDI is not a user activation, so a remembered grant leaves the audio context suspended until the page is clicked.
export const SOUND_BLOCKED = "Click anywhere to enable sound.";
