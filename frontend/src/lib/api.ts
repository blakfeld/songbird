import type { ChatBody } from "@/generated/ChatBody";
import type { ChatEvent } from "@/generated/ChatEvent";
import type { ChatResponse } from "@/generated/ChatResponse";
import type { ChatStreamError } from "@/generated/ChatStreamError";
import type { LyricsAssistBody } from "@/generated/LyricsAssistBody";
import type { LyricsAssistResponse } from "@/generated/LyricsAssistResponse";
import type { GenerateRequestBody } from "@/generated/GenerateRequestBody";
import type { GenerationLimits } from "@/generated/GenerationLimits";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Pattern } from "@/generated/Pattern";
import type { Song } from "@/generated/Song";
import type { SongLimits } from "@/generated/SongLimits";
import type { TrackGenerateBody } from "@/generated/TrackGenerateBody";
import type { TrackGenerateResponse } from "@/generated/TrackGenerateResponse";
import type { AiKeySummary, AiProvider } from "./aiKeys/types";
import { signOutLocally } from "./auth/signOut";
import { midiFilename, songMidiFilename } from "./midiFilename";
import { parseSse } from "./sse";

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
  api_key_required: "AI features need your own Anthropic or OpenAI key.",
  invalid_api_key_format: "That doesn't look like a valid API key for this provider.",
};

const NETWORK_MESSAGE = "Could not reach the Songbird service. Check your connection and try again.";
const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

// The chat route reports these at 400 where the track route uses 422; the reason is just as readable either way.
// The api_key_* messages are readable at 409 and 429 too, because the server names the provider in them.
const READABLE_VALIDATION_CODES = new Set([
  "invalid_song",
  "invalid_prompt",
  "api_key_invalid",
  "api_key_quota_exhausted",
  "api_key_rate_limited",
  "api_key_rejected",
]);

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
  // Lets a caller cancel a request it no longer wants; the abort surfaces as the fetch's own AbortError.
  signal?: AbortSignal;
}

export async function request(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, options.signal ? { ...init, signal: options.signal } : init);
  } catch (e) {
    // An abort is the caller's decision, not a connectivity failure, so it must stay distinguishable.
    if (options.signal?.aborted) throw e;
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

function putJson(path: string, body: unknown): Promise<Response> {
  return request(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export async function getAiKeys(): Promise<AiKeySummary> {
  return (await request("/api/v1/account/ai-keys")).json();
}

export async function saveAiKey(provider: AiProvider, key: string): Promise<AiKeySummary> {
  return (await putJson(`/api/v1/account/ai-keys/${provider}`, { key })).json();
}

export async function removeAiKey(provider: AiProvider): Promise<AiKeySummary> {
  return (await request(`/api/v1/account/ai-keys/${provider}`, { method: "DELETE" })).json();
}

export async function setAiProvider(provider: AiProvider): Promise<AiKeySummary> {
  return (await putJson("/api/v1/account/ai-provider", { provider })).json();
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

// Three missed 15 s server keepalives, so silence this long means the connection is dead.
const STREAM_IDLE_MS = 45_000;

class StreamIdleError extends Error {}

const FORWARDED_EVENTS = new Set<string>(["progress", "reply_delta", "reply_reset", "result"]);

// Keepalive comments produce no parsed events, so idleness is measured on raw bytes before parsing.
function withIdleTimeout(body: ReadableStream<Uint8Array>, ms: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamIdleError()), ms);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), idle]);
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (e) {
        void reader.cancel().catch(() => undefined);
        controller.error(e);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

function streamEventError(data: ChatStreamError): ApiError {
  const retryAfterMs = data.retry_after !== undefined && data.retry_after > 0 ? data.retry_after * 1000 : undefined;
  return new ApiError(data.code, messageFor(data.code, 200, data.message), 200, retryAfterMs);
}

export interface StreamChatOptions {
  signal?: AbortSignal;
  onEvent: (event: ChatEvent) => void;
}

// Resolves only after a `result` event; every other ending throws, so callers never mistake a truncated stream for success.
export async function streamChat(body: ChatBody, { signal, onEvent }: StreamChatOptions): Promise<void> {
  const res = await request(
    "/api/v1/songs/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    },
    { signal },
  );
  const networkError = () => new ApiError("network_error", NETWORK_MESSAGE, 0);

  // A proxy that strips the stream still delivers the complete answer as plain JSON.
  if (res.headers.get("Content-Type")?.includes("application/json") || !res.body) {
    let data: ChatResponse;
    try {
      data = await res.json();
    } catch (e) {
      if (signal?.aborted) throw e;
      throw networkError();
    }
    onEvent({ event: "result", data });
    return;
  }

  let handlerError: { error: unknown } | undefined;
  try {
    for await (const message of parseSse(withIdleTimeout(res.body, STREAM_IDLE_MS))) {
      let data: unknown;
      try {
        data = JSON.parse(message.data);
      } catch {
        continue;
      }
      if (message.event === "error") {
        const error = streamEventError(data as ChatStreamError);
        if (error.code === "unauthenticated") await signOutLocally();
        throw error;
      }
      // Anything else, including the default "message" event, is not part of the ChatEvent union.
      if (!FORWARDED_EVENTS.has(message.event)) continue;
      try {
        onEvent({ event: message.event, data } as ChatEvent);
      } catch (e) {
        handlerError = { error: e };
        throw e;
      }
      if (message.event === "result") return;
    }
  } catch (e) {
    // A throwing handler is a bug in the caller, so it must not be reported as a dropped connection.
    if (e instanceof ApiError || signal?.aborted || (handlerError && e === handlerError.error)) throw e;
    throw networkError();
  }
  throw networkError();
}

// Its 422 codes all carry readable reasons, which messageFor already surfaces for any 422.
export async function assistLyrics(body: LyricsAssistBody): Promise<LyricsAssistResponse> {
  return (await postJson("/api/v1/lyrics/assist", body)).json();
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
