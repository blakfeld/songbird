import { ApiError } from "@/lib/api";

export const AI_KEYS_PATH = "/settings/ai-keys";

export const PROVIDER_LABEL = { anthropic: "Anthropic", openai: "OpenAI" } as const;

export interface ErrorAction {
  href: string;
  label: string;
}

export const isKeyErrorCode = (code: string) => code.startsWith("api_key_");

// The path is read at call time so the link returns to wherever the user was when the error happened.
export function settingsHref(): string {
  if (typeof window === "undefined" || window.location.pathname === AI_KEYS_PATH) return AI_KEYS_PATH;
  const here = window.location.pathname + window.location.search;
  return `${AI_KEYS_PATH}?next=${encodeURIComponent(here)}`;
}

function keyErrorAction(code: string): ErrorAction | undefined {
  switch (code) {
    case "api_key_required":
      return { href: settingsHref(), label: "Add a key" };
    case "api_key_invalid":
      return { href: settingsHref(), label: "Replace key" };
    case "api_key_quota_exhausted":
      return { href: settingsHref(), label: "Manage keys" };
    default:
      // A rate limit clears by itself, so sending the user to settings would only distract.
      return undefined;
  }
}

export interface DescribedError {
  message: string;
  action?: ErrorAction;
}

export function describeError(err: unknown, fallback = "Something went wrong."): DescribedError {
  if (!(err instanceof ApiError)) return { message: err instanceof Error ? err.message : fallback };
  let message = err.message;
  if (err.code === "api_key_rate_limited" && err.retryAfterMs !== undefined) {
    message += ` Try again in ${Math.ceil(err.retryAfterMs / 1000)} seconds.`;
  }
  return { message, action: keyErrorAction(err.code) };
}
