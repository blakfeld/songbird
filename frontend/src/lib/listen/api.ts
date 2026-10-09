import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Song } from "@/generated/Song";

export interface ListenShare {
  mode: "live" | "snapshot";
  allow_comments: boolean;
  allow_downloads: boolean;
  expires_at: number | null;
}

export interface ListenResponse {
  share: ListenShare;
  song: Song;
  instruments: InstrumentInfo[];
  shared_at: number;
}

// Exactly the fields the server accepts, since it refuses unknown ones.
export interface CommentInput {
  name: string;
  body: string;
  at_step: number;
  // The honeypot: a hidden field only a form-filling bot touches. Sent solely when filled, so a person never sends it.
  website?: string;
}

export interface PostedComment {
  id: string;
  name: string;
  body: string;
  at_step: number;
  section_name: string | null;
  created_at: number;
}

export class ListenError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ListenError";
  }
}

export const UNAVAILABLE_MESSAGE = "This link isn't available";
export const RATE_LIMITED_MESSAGE = "Too many requests right now. Please try again shortly.";
const COMMENT_LIMIT_MESSAGE = "This song has reached its comment limit.";
const NETWORK_MESSAGE = "Could not reach the Songbird service. Check your connection and try again.";
const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

async function toListenError(res: Response): Promise<ListenError> {
  let code = "unknown";
  let serverMessage: string | undefined;
  try {
    const body = await res.json();
    if (typeof body?.error?.code === "string") code = body.error.code;
    if (typeof body?.error?.message === "string") serverMessage = body.error.message;
  } catch {
    // A proxy's error page is not JSON; the status alone is enough to pick a message.
  }
  const seconds = Number(res.headers.get("Retry-After"));
  const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  // Every failure but a throttle looks the same on purpose, so the page cannot say why a link is gone.
  if (res.status === 404) return new ListenError("not_found", UNAVAILABLE_MESSAGE, 404);
  if (res.status === 429) return new ListenError("too_many_requests", RATE_LIMITED_MESSAGE, 429, retryAfterMs);
  if (code === "comment_limit") return new ListenError(code, COMMENT_LIMIT_MESSAGE, res.status);
  // The server's validation reasons are written for the person who typed the comment.
  if (code === "invalid_comment" && serverMessage) return new ListenError(code, serverMessage, res.status);
  return new ListenError(code, FALLBACK_MESSAGE, res.status);
}

// Deliberately not built on the Studio's request helper: that one signs the user out on a 401, and a listener
// may be a signed-in owner whose session this page must leave alone. No credentials are sent either, since the
// listen API ignores a session anyway.
async function listenFetch(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, credentials: "omit" });
  } catch (e) {
    if (init?.signal?.aborted) throw e;
    throw new ListenError("network_error", NETWORK_MESSAGE, 0);
  }
  if (!res.ok) throw await toListenError(res);
  return res;
}

const base = (token: string) => `/api/v1/listen/${encodeURIComponent(token)}`;

export const midiUrl = (token: string) => `${base(token)}/midi`;

export async function getShare(token: string, signal?: AbortSignal): Promise<ListenResponse> {
  return (await listenFetch(base(token), { signal })).json();
}

export async function postComment(token: string, input: CommentInput): Promise<PostedComment> {
  const { name, body, at_step, website } = input;
  const res = await listenFetch(`${base(token)}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, body, at_step, ...(website && { website }) }),
  });
  return ((await res.json()) as { comment: PostedComment }).comment;
}

export async function getMidi(token: string): Promise<Blob> {
  return (await listenFetch(midiUrl(token))).blob();
}
