import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptForm } from "@/components/editor/PromptForm";
import { useChat } from "@/components/studio/useChat";
import { useTrackGeneration } from "@/components/studio/useTrackGeneration";
import * as api from "@/lib/api";
import { getPatternStore } from "@/lib/patternStore";
import { createSongStore } from "@/lib/song/songStore";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import { AiKeysProvider, useAiKeys } from "./AiKeysProvider";

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u1", email: "ana@example.com" } }),
}));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getAiKeys: vi.fn(),
  generateTrack: vi.fn(),
  generatePattern: vi.fn(),
  sendChat: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

const withKey = {
  keys_required: true,
  active_provider: "anthropic" as const,
  keys: [{ provider: "anthropic" as const, last4: "abcd", updated_at: 1767225600000 }],
};
const withoutKey = { keys_required: true, active_provider: null, keys: [] };

const wrapper = ({ children }: { children: ReactNode }) => <AiKeysProvider>{children}</AiKeysProvider>;
const keyError = (code: string, status = 409) => new api.ApiError(code, "message", status);

describe("AiKeysProvider", () => {
  it("loads the summary once and exposes it", async () => {
    vi.mocked(api.getAiKeys).mockResolvedValue(withKey);
    const { result } = renderHook(() => useAiKeys(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ keysRequired: true, activeProvider: "anthropic", keys: withKey.keys });
    expect(api.getAiKeys).toHaveBeenCalledTimes(1);
  });

  it("reports api_keys_unavailable as its own status, not an error", async () => {
    vi.mocked(api.getAiKeys).mockRejectedValue(keyError("api_keys_unavailable", 503));
    const { result } = renderHook(() => useAiKeys(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.keysRequired).toBe(false);
  });

  it("keeps the last summary when a later refresh fails", async () => {
    vi.mocked(api.getAiKeys).mockResolvedValueOnce(withKey).mockRejectedValue(new api.ApiError("network_error", "x", 0));
    const { result } = renderHook(() => useAiKeys(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(() => result.current.refresh());
    expect(result.current.status).toBe("ready");
    expect(result.current.activeProvider).toBe("anthropic");
  });
});

describe("refetching the summary on api_key_* errors", () => {
  it("useTrackGeneration refetches on api_key_required and keeps the code's link", async () => {
    vi.mocked(api.getAiKeys).mockResolvedValueOnce(withKey).mockResolvedValue(withoutKey);
    vi.mocked(api.generateTrack).mockRejectedValue(keyError("api_key_required"));
    const store = createSongStore(newSongWithTracks());
    const { result } = renderHook(
      () => ({ gen: useTrackGeneration(store, vi.fn(), (edit) => edit()), keys: useAiKeys() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.keys.activeProvider).toBe("anthropic"));

    await act(() => result.current.gen.submit(store.getState().song!.tracks[0].id, { prompt: "p" }));

    expect(api.getAiKeys).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.keys.activeProvider).toBeNull());
    expect(result.current.gen.dialog?.error?.action?.label).toBe("Add a key");
  });

  it("does not refetch for unrelated errors", async () => {
    vi.mocked(api.getAiKeys).mockResolvedValue(withKey);
    vi.mocked(api.generateTrack).mockRejectedValue(keyError("generation_failed", 502));
    const store = createSongStore(newSongWithTracks());
    const { result } = renderHook(() => ({ gen: useTrackGeneration(store, vi.fn(), (edit) => edit()), keys: useAiKeys() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.keys.status).toBe("ready"));
    await act(() => result.current.gen.submit(store.getState().song!.tracks[0].id, { prompt: "p" }));
    expect(api.getAiKeys).toHaveBeenCalledTimes(1);
  });

  it("useChat refetches on api_key_invalid and offers a Replace key link", async () => {
    vi.mocked(api.getAiKeys).mockResolvedValue(withKey);
    vi.mocked(api.sendChat).mockRejectedValue(keyError("api_key_invalid"));
    const store = createSongStore(newSongWithTracks());
    const { result } = renderHook(() => ({ chat: useChat(store, vi.fn()), keys: useAiKeys() }), { wrapper });
    await waitFor(() => expect(result.current.keys.status).toBe("ready"));

    await act(() => result.current.chat.send("add a bass"));

    expect(api.getAiKeys).toHaveBeenCalledTimes(2);
    expect(result.current.chat.errorAction?.label).toBe("Replace key");
  });

  it("useChat gives no link for api_key_rate_limited", async () => {
    vi.mocked(api.getAiKeys).mockResolvedValue(withKey);
    vi.mocked(api.sendChat).mockRejectedValue(new api.ApiError("api_key_rate_limited", "Anthropic is rate limiting you.", 429, 30_000));
    const store = createSongStore(newSongWithTracks());
    const { result } = renderHook(() => ({ chat: useChat(store, vi.fn()), keys: useAiKeys() }), { wrapper });
    await waitFor(() => expect(result.current.keys.status).toBe("ready"));
    await act(() => result.current.chat.send("add a bass"));
    expect(result.current.chat.errorAction).toBeUndefined();
    expect(result.current.chat.error).toContain("Try again in 30 seconds.");
  });

  it("PromptForm refetches on api_key_required and shows the settings link", async () => {
    vi.mocked(api.getAiKeys).mockResolvedValue(withKey);
    vi.mocked(api.generatePattern).mockRejectedValue(keyError("api_key_required"));
    getPatternStore("drums").getState().setPrompt("boom bap");
    render(
      <AiKeysProvider>
        <PromptForm
          instrumentId="drums"
          limits={{ max_input_tokens: 256, measure_options: [4] }}
          limitsState="ready"
          onRetryLimits={vi.fn()}
          onGenerated={vi.fn()}
          measures={4}
          onMeasuresChange={vi.fn()}
          timeSignature="4/4"
          onTimeSignatureChange={vi.fn()}
        />
      </AiKeysProvider>,
    );
    await waitFor(() => expect(api.getAiKeys).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(api.getAiKeys).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("link", { name: "Add a key" })).toBeInTheDocument();
  });
});
