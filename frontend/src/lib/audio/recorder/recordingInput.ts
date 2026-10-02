import type { PlaybackEngine } from "../engine";
import type { InputFailure } from "./inputManager";
import type { RecorderTap } from "./recorderTap";
import { inputOwner, type InputOwner } from "./trackInput";

export type InputRefusal = InputFailure;

// What a take needs from the input once it is open. The owner shares one stream between the meter, monitoring and
// the take, so releasing this lets go of the take's hold only.
export interface RecordingInput {
  tap: RecorderTap;
  sampleRate: number;
  channels: 1 | 2;
  inputLatency: number;
  fellBack: boolean;
  release(): void;
  // A device that disappears mid-take is the one failure the take cannot see for itself.
  onLost?(cb: () => void): () => void;
}

// The press that starts a take is the user gesture, so this asks for permission itself rather than earlier.
export function openRecordingInput(
  engine: Pick<PlaybackEngine, "prepareInput">,
  trackId: string,
  owner: InputOwner = inputOwner,
): Promise<{ input: RecordingInput } | { reason: InputRefusal }> {
  return owner.acquire(engine, trackId, "record");
}
