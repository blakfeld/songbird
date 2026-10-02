import type { AudioTakeOutcome } from "@/lib/recording/take";

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

const bars = (n: number) => `${n} bar${n === 1 ? "" : "s"}`;

const LIMIT_SENTENCE = (trackName: string) => ({
  seek: "Recording stopped because playback was moved. What was recorded is kept.",
  input: `${trackName} input disconnected. Recording stopped. What was recorded is kept.`,
  duration: "Recording stopped after 20 minutes. What was recorded is kept.",
  song: "Recording stopped at measure 128, the end of the song. What was recorded is kept.",
  takes: "Recording stopped because the track has the most takes it can hold. What was recorded is kept.",
  samples: "Recording stopped because the song has the most samples it can hold. What was recorded is kept.",
});

// Saving outlasts the take, so these arrive after Stop and have to stand alone as the final word.
export function audioTakeMessage(outcome: AudioTakeOutcome): string {
  if (outcome.kind === "failed") {
    return outcome.reason === "storage"
      ? "Couldn't save the recording because browser storage is full. Nothing was added. Remove unused samples or takes, then try again."
      : "Couldn't add the recording to the song. Nothing was added.";
  }
  const limit = outcome.limit ? `${LIMIT_SENTENCE(outcome.trackName)[outcome.limit]} ` : "";
  if (outcome.kind === "empty") return `${limit}Nothing was recorded.`.trim();
  return outcome.takes === 1
    ? `${limit}Recorded ${outcome.takeName}, ${bars(outcome.measures)}. Undo removes the take.`
    : `${limit}Recorded ${outcome.takes} takes on ${outcome.trackName}. The clip plays ${outcome.takeName}. Earlier passes are in its Takes list.`;
}

// Kept beside the MIDI copy so the two permission explanations read alike.
export const DENIED_MIC_TEXT =
  "Microphone access is blocked for this site, so audio can't be recorded. To allow it, click the site settings icon beside the address bar, set Microphone to Allow, then choose Try again. Everything else still works.";
