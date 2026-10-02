import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptForm } from "@/components/editor/PromptForm";
import { AssistantPanel } from "@/components/studio/AssistantPanel";
import { TrackGenerateDialog } from "@/components/studio/TrackGenerateDialog";
import type { ChatController } from "@/components/studio/useChat";
import type { AiKeySummary } from "@/lib/aiKeys/types";
import * as api from "@/lib/api";
import { getPatternStore } from "@/lib/patternStore";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import { AiKeysProvider } from "./AiKeysProvider";

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u1", email: "ana@example.com" } }),
}));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getAiKeys: vi.fn(),
  getSongLimits: vi.fn(),
}));

const required: AiKeySummary = { keys_required: true, active_provider: null, keys: [] };
const notRequired: AiKeySummary = { keys_required: false, active_provider: null, keys: [] };
const hasKey: AiKeySummary = {
  keys_required: true,
  active_provider: "anthropic",
  keys: [{ provider: "anthropic", last4: "abcd", updated_at: 1767225600000 }],
};

const song = newSongWithTracks();
const chat: ChatController = {
  sending: false,
  pending: null,
  error: null,
  errorAction: undefined,
  send: vi.fn(async () => "sent" as const),
  dismissError: vi.fn(),
};

const promptForm = () => (
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
);

const controls: [string, () => ReactNode, () => Promise<void>, () => HTMLElement][] = [
  [
    "PromptForm Generate",
    promptForm,
    async () => {
      getPatternStore("drums").getState().setPrompt("boom bap");
    },
    () => screen.getByRole("button", { name: "Generate" }),
  ],
  [
    "TrackGenerateDialog Generate",
    () => (
      <TrackGenerateDialog open song={song} track={song.tracks[0]} initialPrompt="walking bass" onSubmit={vi.fn()} onClose={vi.fn()} />
    ),
    async () => {},
    () => screen.getByRole("button", { name: "Generate" }),
  ],
  [
    "AssistantPanel Send",
    () => <AssistantPanel song={song} chat={chat} instruments={null} />,
    async () => {
      await userEvent.type(screen.getByLabelText("Message the assistant"), "add a bass");
    },
    () => screen.getByRole("button", { name: "Send message" }),
  ],
];

function renderWith(summary: AiKeySummary, ui: ReactNode) {
  vi.mocked(api.getAiKeys).mockResolvedValue(summary);
  return render(<AiKeysProvider>{ui}</AiKeysProvider>);
}

beforeEach(() => {
  vi.mocked(api.getSongLimits).mockResolvedValue({ max_input_tokens: 256 } as Awaited<ReturnType<typeof api.getSongLimits>>);
});
afterEach(() => vi.resetAllMocks());

describe.each(controls)("%s", (_name, ui, prepare, control) => {
  it("is disabled with a settings link when a key is required and none is active", async () => {
    renderWith(required, ui());
    await prepare();
    const link = await screen.findByRole("link", { name: "Add a key" });
    expect(link.getAttribute("href")).toMatch(/^\/settings\/ai-keys/);
    await waitFor(() => expect(control()).toBeDisabled());
    expect(control()).toHaveAccessibleDescription(/Anthropic or OpenAI key/);
  });

  it("is enabled when keys are not required", async () => {
    renderWith(notRequired, ui());
    await prepare();
    await waitFor(() => expect(control()).toBeEnabled());
    expect(screen.queryByRole("link", { name: "Add a key" })).not.toBeInTheDocument();
  });

  it("is enabled when a provider is active", async () => {
    renderWith(hasKey, ui());
    await prepare();
    await waitFor(() => expect(control()).toBeEnabled());
  });

  it("stays open while the summary is still loading", async () => {
    vi.mocked(api.getAiKeys).mockReturnValue(new Promise(() => {}));
    render(<AiKeysProvider>{ui()}</AiKeysProvider>);
    await prepare();
    await waitFor(() => expect(control()).toBeEnabled());
    expect(screen.queryByRole("link", { name: "Add a key" })).not.toBeInTheDocument();
  });

  it("stays open when the summary fails to load", async () => {
    vi.mocked(api.getAiKeys).mockRejectedValue(new api.ApiError("network_error", "offline", 0));
    render(<AiKeysProvider>{ui()}</AiKeysProvider>);
    await prepare();
    await waitFor(() => expect(api.getAiKeys).toHaveBeenCalled());
    await waitFor(() => expect(control()).toBeEnabled());
  });
});
