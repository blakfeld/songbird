import { ApiError } from "@/lib/api";
import { PROVIDER_LABEL } from "@/lib/aiKeys/keyError";
import type { AiProvider } from "@/lib/aiKeys/types";

export const spell = (last4: string) => last4.split("").join(" ");

export const KEY_HINT: Record<AiProvider, string> = {
  anthropic: "Starts with sk-ant-. Songbird checks it with Anthropic before saving.",
  openai: "Starts with sk-. Songbird checks it with OpenAI before saving.",
};

// Page-local because the copy has to name the provider, which the generic USER_MESSAGES entries cannot.
export function saveErrorMessage(err: unknown, provider: AiProvider): string {
  const name = PROVIDER_LABEL[provider];
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  switch (err.code) {
    case "invalid_api_key_format":
      return provider === "anthropic"
        ? "That doesn't look like an Anthropic key. Anthropic keys start with sk-ant- and contain only letters, numbers, - and _."
        : "That doesn't look like an OpenAI key. OpenAI keys start with sk-. Anthropic keys (sk-ant-) go in the Anthropic row.";
    case "api_key_rejected":
      return `${name} rejected this key. Check that you copied all of it and that it hasn't been revoked.`;
    case "provider_unreachable":
      return `Couldn't reach ${name} to check the key. Nothing was saved. Try again in a moment.`;
    case "too_many_requests": {
      if (err.retryAfterMs === undefined) return "Too many key checks. Try again later.";
      const minutes = Math.ceil(err.retryAfterMs / 60_000);
      return `Too many key checks. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
    }
    case "api_keys_unavailable":
      return "Key management is turned off on this server.";
    default:
      return err.message;
  }
}
