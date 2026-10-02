import type { Note } from "@/generated/Note";
import { mergeNotes } from "../patternOps";
import type { DropReason } from "../song/clipOps";

// Steps come from the engine already mapped to the transport, so quantizing needs no timing knowledge.
export interface MappedStep {
  step: number;
  // Present when the engine could supply them; they are what tells a note held a whole loop pass from a brief one.
  seconds?: number;
  stepSeconds?: number;
}

export interface QuantizeInput {
  row_id: string;
  velocity: number;
  on: MappedStep;
  // Null when the engine could no longer map the release, which reads as "held to the end".
  off: MappedStep | null;
  // Half-open: the steps being played, which is the loop region while looping and the whole thing otherwise.
  range: { start: number; end: number };
  looping: boolean;
  oneShot: boolean;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function heldMostOfPass({ on, off }: QuantizeInput, passSteps: number): boolean {
  if (!off || on.seconds === undefined || off.seconds === undefined || !off.stepSeconds) return false;
  return off.seconds - on.seconds >= (passSteps * off.stepSeconds) / 2;
}

// Null means the note is discarded: it fell outside what is being played, or past the end with looping off.
export function quantizeNote(input: QuantizeInput): Note | null {
  const { range, looping } = input;
  const step = input.on.step;
  if (step < range.start || step >= range.end) return null;

  const room = range.end - step;
  let length = room;
  if (!input.oneShot && input.off) {
    // Playback order, not numeric order: a note held across a loop wrap releases at a smaller step.
    length = input.off.step - step;
    const pass = range.end - range.start;
    if (length < 0 && looping) length += pass;
    // Releasing on the step it was pressed looks like a brief tap, unless a pass or more of time went by.
    // Half a pass is the threshold because both ends are rounded to a step, so the measured gap jitters.
    if (length === 0 && looping && heldMostOfPass(input, pass)) length = pass;
    if (length < 0) length = room;
  }
  return {
    row_id: input.row_id,
    step,
    length_steps: input.oneShot ? 1 : clamp(length, 1, room),
    velocity: clamp(Math.round(input.velocity), 1, 127),
  };
}

// Recorded notes are re-merged onto the untouched base each time, so they resolve collisions in start order
// even though they arrive in release order.
export interface Take {
  add: (note: Note) => Note[];
  recorded: () => Note[];
}

export function createTake(baseNotes: Note[]): Take {
  const recorded: Note[] = [];
  return {
    add: (note) => {
      recorded.push(note);
      return mergeNotes(baseNotes, recorded);
    },
    recorded: () => recorded,
  };
}

// Why a recording stopped by itself, so the announcement can say it instead of leaving the user to wonder.
export type AudioTakeLimit = "duration" | "song" | "section" | "takes" | "samples" | "input" | "seek";

export type AudioTakeOutcome =
  | { kind: "saved"; trackName: string; takeName: string; takes: number; measures: number; limit?: AudioTakeLimit }
  | { kind: "empty"; trackName: string; limit?: AudioTakeLimit }
  | { kind: "failed"; reason: "storage" | "song" };

export interface TakeSummary {
  recorded: number;
  dropped: Partial<Record<DropReason, number>>;
  // Audio is hashed and stored after the take ends, so its result arrives later than a note take's.
  settled?: Promise<AudioTakeOutcome>;
}

// What the input router drives, so it never needs to know which page owns the notes.
export interface TakeTarget {
  begin: () => void;
  add: (note: Note) => void;
  // Whatever the take still has pending is committed here, so the page only has to announce the result.
  end: () => TakeSummary;
  // Used when the take is abandoned, such as Stop during the count-in.
  discard: () => void;
  // Lets a take that hits a limit ask the page to stop, since only the page owns the transport.
  onLimit?: (cb: (limit: AudioTakeLimit) => void) => () => void;
}
