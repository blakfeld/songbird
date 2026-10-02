import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiKeysProvider } from "@/components/ai/AiKeysProvider";
import type { AiKeySummary } from "@/lib/aiKeys/types";
import * as api from "@/lib/api";
import { AiKeysPage } from "./AiKeysPage";

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u1", email: "ana@example.com" } }),
}));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getAiKeys: vi.fn(),
  saveAiKey: vi.fn(),
  removeAiKey: vi.fn(),
  setAiProvider: vi.fn(),
}));

const SECRET = "sk-ant-super-secret-value-1234";
const entry = (provider: "anthropic" | "openai", last4: string) => ({
  provider,
  last4,
  updated_at: 1767225600000,
});

const empty: AiKeySummary = { keys_required: true, active_provider: null, keys: [] };
const anthropicOnly: AiKeySummary = {
  keys_required: true,
  active_provider: "anthropic",
  keys: [entry("anthropic", "abcd")],
};
const both: AiKeySummary = {
  keys_required: true,
  active_provider: "anthropic",
  keys: [entry("anthropic", "abcd"), entry("openai", "wxyz")],
};

function renderPage(summary: AiKeySummary) {
  vi.mocked(api.getAiKeys).mockResolvedValue(summary);
  render(
    <AiKeysProvider>
      <AiKeysPage />
    </AiKeysProvider>,
  );
}

const row = (name: string) => screen.getByRole("heading", { name }).closest("li")!;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.resetAllMocks());

function expectNoSecretInStorage() {
  for (const store of [localStorage, sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)!;
      expect(key).not.toContain(SECRET);
      expect(store.getItem(key)).not.toContain(SECRET);
    }
  }
}

describe("AiKeysPage", () => {
  it("shows the masked suffix, with the characters spelled out for screen readers", async () => {
    renderPage(anthropicOnly);
    const anthropic = await screen.findByRole("heading", { name: "Anthropic" });
    const li = anthropic.closest("li")!;
    expect(li).toHaveTextContent("••••abcd");
    expect(li).toHaveTextContent("ending in a b c d");
    expect(within(row("OpenAI")).getByText("Not set")).toBeInTheDocument();
    expect(within(li).getByRole("button", { name: "Replace Anthropic key" })).toBeInTheDocument();
    expect(within(li).getByRole("button", { name: "Remove Anthropic key" })).toBeInTheDocument();
  });

  it("clears the input after a successful save and stores the key nowhere", async () => {
    renderPage(empty);
    vi.mocked(api.saveAiKey).mockResolvedValue({
      keys_required: true,
      active_provider: "anthropic",
      keys: [entry("anthropic", "1234")],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Set Anthropic key" }));
    const input = screen.getByLabelText("Anthropic API key");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveFocus();
    await userEvent.type(input, SECRET);
    expectNoSecretInStorage();
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));

    expect(api.saveAiKey).toHaveBeenCalledWith("anthropic", SECRET);
    await waitFor(() => expect(screen.queryByLabelText("Anthropic API key")).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
    expect(row("Anthropic")).toHaveTextContent("••••1234");
    expect(screen.getByText(/Anthropic key saved, ending in 1 2 3 4\. Anthropic is now used/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace Anthropic key" })).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Replace Anthropic key" }));
    expect(screen.getByLabelText("Anthropic API key")).toHaveValue("");
    expectNoSecretInStorage();
  });

  it("clears the input after a failed save and shows the provider-specific error", async () => {
    renderPage(empty);
    vi.mocked(api.saveAiKey).mockRejectedValue(new api.ApiError("api_key_rejected", "server text", 422));
    await userEvent.click(await screen.findByRole("button", { name: "Set Anthropic key" }));
    await userEvent.type(screen.getByLabelText("Anthropic API key"), SECRET);
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Anthropic rejected this key.");
    const input = screen.getByLabelText("Anthropic API key");
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
    expectNoSecretInStorage();
  });

  it("collapses and clears the form on Escape", async () => {
    renderPage(empty);
    await userEvent.click(await screen.findByRole("button", { name: "Set OpenAI key" }));
    await userEvent.type(screen.getByLabelText("OpenAI API key"), "sk-typed");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByLabelText("OpenAI API key")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("sk-typed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set OpenAI key" })).toHaveFocus();
  });

  it("asks before removing, and says which provider takes over", async () => {
    renderPage(both);
    vi.mocked(api.removeAiKey).mockResolvedValue({
      keys_required: true,
      active_provider: "openai",
      keys: [entry("openai", "wxyz")],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Remove Anthropic key" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Remove your Anthropic key?");
    expect(dialog).toHaveTextContent("Songbird will switch to OpenAI");
    expect(api.removeAiKey).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(api.removeAiKey).toHaveBeenCalledWith("anthropic"));
    expect(await screen.findByText(/Anthropic key removed\. OpenAI is now used/)).toBeInTheDocument();
    expect(within(row("Anthropic")).getByText("Not set")).toBeInTheDocument();
  });

  it("shows the provider radio group only when both keys exist, and switches on selection", async () => {
    renderPage(anthropicOnly);
    await screen.findByRole("heading", { name: "Anthropic" });
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Provider for AI features" })).not.toBeInTheDocument();
  });

  it("switches the active provider from the radio group", async () => {
    renderPage(both);
    vi.mocked(api.setAiProvider).mockResolvedValue({ ...both, active_provider: "openai" });
    const group = await screen.findByRole("group", { name: "Provider for AI features" });
    expect(within(group).getByRole("radio", { name: "Anthropic" })).toBeChecked();
    await userEvent.click(within(group).getByRole("radio", { name: "OpenAI" }));
    await waitFor(() => expect(api.setAiProvider).toHaveBeenCalledWith("openai"));
    expect(await screen.findByText("OpenAI is now used for AI features.")).toBeInTheDocument();
    expect(within(group).getByRole("radio", { name: "OpenAI" })).toBeChecked();
  });

  it("reverts the radio and shows the error when the switch fails", async () => {
    renderPage(both);
    vi.mocked(api.setAiProvider).mockRejectedValue(new api.ApiError("api_key_required", "Add a key first.", 409));
    const group = await screen.findByRole("group", { name: "Provider for AI features" });
    await userEvent.click(within(group).getByRole("radio", { name: "OpenAI" }));
    expect(await within(group).findByRole("alert")).toBeInTheDocument();
    expect(within(group).getByRole("radio", { name: "Anthropic" })).toBeChecked();
  });

  it("refetches the summary and drops the radio group when the switch hits api_key_required", async () => {
    renderPage(both);
    vi.mocked(api.setAiProvider).mockRejectedValue(new api.ApiError("api_key_required", "Add a key first.", 409));
    const group = await screen.findByRole("group", { name: "Provider for AI features" });
    vi.mocked(api.getAiKeys).mockResolvedValue(anthropicOnly);
    await userEvent.click(within(group).getByRole("radio", { name: "OpenAI" }));
    await waitFor(() => expect(api.getAiKeys).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Provider for AI features" })).not.toBeInTheDocument(),
    );
    expect(within(row("OpenAI")).getByText("Not set")).toBeInTheDocument();
  });

  it("explains a shared provider when keys are not required, but still offers key management", async () => {
    renderPage({ keys_required: false, active_provider: null, keys: [] });
    expect(await screen.findByText(/shared development provider, so AI features work without your own key/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set Anthropic key" })).toBeInTheDocument();
  });

  it("shows only a notice when key management is unavailable", async () => {
    vi.mocked(api.getAiKeys).mockRejectedValue(new api.ApiError("api_keys_unavailable", "off", 503));
    render(
      <AiKeysProvider>
        <AiKeysPage />
      </AiKeysProvider>,
    );
    expect(await screen.findByText(/key management is turned off/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "AI providers" })).not.toBeInTheDocument();
  });

  it("offers a retry when the summary cannot be loaded", async () => {
    vi.mocked(api.getAiKeys).mockRejectedValueOnce(new api.ApiError("network_error", "offline", 0)).mockResolvedValue(empty);
    render(
      <AiKeysProvider>
        <AiKeysPage />
      </AiKeysProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load your AI keys.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Anthropic" })).toBeInTheDocument();
  });
});
