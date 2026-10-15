import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { setUsername } from "@/lib/auth/client";
import { UsernameForm } from "./UsernameForm";

vi.mock("@/lib/auth/client", () => ({ setUsername: vi.fn() }));

const saved = { id: "u1", email: "ana@example.com", username: "ana" };
const field = () => screen.getByLabelText("Username");
const save = () => screen.getByRole("button", { name: /Save username|Saving/ });

beforeEach(() => {
  vi.mocked(setUsername).mockReset().mockResolvedValue(saved);
});

describe("UsernameForm", () => {
  it.each([
    ["1ana", "Start with a letter."],
    ["-ana", "Start with a letter."],
    ["an a", "Use only letters, digits, _ and -."],
    ["ana!", "Use only letters, digits, _ and -."],
    ["an", "Use at least 3 characters."],
    ["a".repeat(31), "Use at most 30 characters."],
  ])("explains the rule %s breaks as the user types", async (typed, message) => {
    render(<UsernameForm onSaved={vi.fn()} />);
    await userEvent.type(field(), typed);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(save()).toBeDisabled();
  });

  it("accepts a valid name, in any letter case, and sends it lowercased", async () => {
    const onSaved = vi.fn();
    render(<UsernameForm onSaved={onSaved} />);
    expect(save()).toBeDisabled();
    await userEvent.type(field(), "Ana_b-2");
    expect(field()).not.toHaveAttribute("aria-invalid");
    await userEvent.click(save());
    expect(setUsername).toHaveBeenCalledWith("ana_b-2");
    expect(await screen.findByText("Username saved.")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  it("shows the taken message and keeps what was typed", async () => {
    vi.mocked(setUsername).mockRejectedValue(new ApiError("username_taken", "That username is taken. Try another.", 409));
    render(<UsernameForm onSaved={vi.fn()} />);
    await userEvent.type(field(), "ana");
    await userEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("That username is taken. Try another.");
    expect(field()).toHaveValue("ana");
    expect(save()).toBeEnabled();
  });

  it("disables saving while the request is in flight and sends it once", async () => {
    let finish: (u: typeof saved) => void = () => {};
    vi.mocked(setUsername).mockReturnValue(new Promise((r) => (finish = r)));
    render(<UsernameForm onSaved={vi.fn()} />);
    await userEvent.type(field(), "ana");
    await userEvent.click(save());
    expect(save()).toBeDisabled();
    expect(save()).toHaveTextContent("Saving…");
    await userEvent.type(field(), "{Enter}");
    expect(setUsername).toHaveBeenCalledTimes(1);
    finish(saved);
    await waitFor(() => expect(save()).toBeEnabled());
  });
});
