import type { ChatBody } from "@/generated/ChatBody";
import type { ChatResponse } from "@/generated/ChatResponse";
import type { GenerateRequestBody } from "@/generated/GenerateRequestBody";
import type { GenerationLimits } from "@/generated/GenerationLimits";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Pattern } from "@/generated/Pattern";
import type { Song } from "@/generated/Song";
import type { SongLimits } from "@/generated/SongLimits";
import type { TrackGenerateBody } from "@/generated/TrackGenerateBody";
import type { TrackGenerateResponse } from "@/generated/TrackGenerateResponse";
import { signOutLocally } from "./auth/signOut";
import { midiFilename, songMidiFilename } from "./midiFilename";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    // Set from `Retry-After` so a throttled caller can wait exactly as long as the server asked.
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Server messages are developer-oriented; these are what a songwriter should see.
const USER_MESSAGES: Record<string, string> = {
  invalid_json: "The request could not be understood. Please try again.",
  not_found: "That resource was not found.",
  payload_too_large: "The request was too large to send.",
  prompt_too_long: "Your description is too long. Shorten it and try again.",
  invalid_instrument: "That instrument is not supported.",
  generation_failed: "The AI could not generate a pattern. Please try again.",
  generation_timeout: "Generation took too long. Please try again.",
  generation_busy: "The generator is busy right now. Please try again in a moment.",
  invalid_range: "That measure range can't be generated. Choose a range of up to 32 measures inside the song.",
  invalid_track: "That track is no longer in the song.",
  unauthenticated: "Your session has ended. Please sign in again.",
  invalid_credentials: "Email or password is incorrect.",
  forbidden: "You don't have permission to do that.",
  revision_conflict: "This song was changed somewhere else. Reload it or save your version as a copy.",
  project_limit: "You've reached your limit for stored songs. Delete a song and try again.",
  id_mismatch: "This song doesn't match the one being saved. Reload it and try again.",
  too_many_requests: "Too many attempts. Please try again later.",
  server_busy: "The service is busy. Please try again later.",
};

const NETWORK_MESSAGE = "Could not reach the Songbird service. Check your connection and try again.";
const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

// The chat route reports these at 400 where the track route uses 422; the reason is just as readable either way.
const READABLE_VALIDATION_CODES = new Set(["invalid_song", "invalid_prompt"]);

function messageFor(code: string, status: number, serverMessage?: string): string {
  const mapped = USER_MESSAGES[code];
  if (mapped) return mapped;
  // Other 422 validation codes carry a specific, already-readable reason.
  if ((status === 422 || READABLE_VALIDATION_CODES.has(code)) && serverMessage) return serverMessage;
  return FALLBACK_MESSAGE;
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = "unknown";
  let serverMessage: string | undefined;
  try {
    const body = await res.json();
    if (typeof body?.error?.code === "string") code = body.error.code;
    if (typeof body?.error?.message === "string") serverMessage = body.error.message;
  } catch {
    // Proxies and gateways return non-JSON error pages; the status alone must suffice.
  }
  const seconds = Number(res.headers.get("Retry-After"));
  const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  return new ApiError(code, messageFor(code, res.status, serverMessage), res.status, retryAfterMs);
}

export interface RequestOptions {
  // The login page checks for a session on purpose while signed out, so its 401 must not trigger a sign-out.
  signOutOnUnauthenticated?: boolean;
}

export async function request(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("network_error", NETWORK_MESSAGE, 0);
  }
  if (!res.ok) {
    const error = await toApiError(res);
    // Keyed on the code, not the status: a wrong password at login is also a 401 and must not sign out.
    if (error.code === "unauthenticated" && options.signOutOnUnauthenticated !== false) await signOutLocally();
    throw error;
  }
  return res;
}

export function postJson(path: string, body: unknown): Promise<Response> {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function getInstruments(): Promise<InstrumentInfo[]> {
  return (await request("/api/v1/instruments")).json();
}

export async function getLimits(): Promise<GenerationLimits> {
  return (await request("/api/v1/patterns/limits")).json();
}

export async function generatePattern(body: GenerateRequestBody): Promise<Pattern> {
  return (await postJson("/api/v1/patterns/generate", body)).json();
}

export async function getSongLimits(): Promise<SongLimits> {
  return (await request("/api/v1/songs/limits")).json();
}

export async function generateTrack(body: TrackGenerateBody): Promise<TrackGenerateResponse> {
  return (await postJson("/api/v1/songs/tracks/generate", body)).json();
}

export async function sendChat(body: ChatBody): Promise<ChatResponse> {
  return (await postJson("/api/v1/songs/chat", body)).json();
}

export interface MidiExport {
  blob: Blob;
  filename: string;
}

function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (!match) return fallback;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export async function exportMidi(pattern: Pattern): Promise<MidiExport> {
  const res = await postJson("/api/v1/patterns/export/midi", pattern);
  return {
    blob: await res.blob(),
    filename: filenameFrom(res.headers.get("Content-Disposition"), midiFilename(pattern)),
  };
}

export async function exportSongMidi(song: Song): Promise<MidiExport> {
  const res = await postJson("/api/v1/songs/export/midi", song);
  return {
    blob: await res.blob(),
    filename: filenameFrom(res.headers.get("Content-Disposition"), songMidiFilename(song)),
  };
}
