import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { setUsername } from "@/lib/auth/client";
import { ProfilePage } from "./ProfilePage";

const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("@/components/auth/AuthProvider", () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock("@/components/auth/AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("@/lib/auth/client", () => ({ setUsername: vi.fn() }));

beforeEach(() => {
  auth.user = { id: "u1", email: "ana@example.com", username: null };
  vi.mocked(setUsername).mockReset();
});

describe("Profile page", () => {
  it("shows the email and says when no username is set", () => {
    render(<ProfilePage />);
    expect(screen.getByRole("heading", { level: 1, name: "Profile" })).toBeInTheDocument();
    expect(screen.getByText("ana@example.com")).toBeInTheDocument();
    expect(screen.getByText("No username set")).toBeInTheDocument();
    expect(screen.getByText(/shown to song owners next to the comments you leave/)).toBeInTheDocument();
  });

  it("shows the current username in the form", () => {
    auth.user = { id: "u1", email: "ana@example.com", username: "ana" };
    render(<ProfilePage />);
    expect(screen.queryByText("No username set")).toBeNull();
    expect(screen.getByLabelText("Username")).toHaveValue("ana");
  });

  it("shows the new username after saving", async () => {
    vi.mocked(setUsername).mockResolvedValue({ id: "u1", email: "ana@example.com", username: "ana" });
    render(<ProfilePage />);
    await userEvent.type(screen.getByLabelText("Username"), "ana");
    await userEvent.click(screen.getByRole("button", { name: "Save username" }));
    expect(await screen.findByText("Username saved.")).toBeInTheDocument();
    expect(screen.queryByText("No username set")).toBeNull();
    expect(screen.getAllByText("ana").length).toBeGreaterThan(0);
  });

  it("says the username is taken and keeps what was typed", async () => {
    vi.mocked(setUsername).mockRejectedValue(new ApiError("username_taken", "That username is taken. Try another.", 409));
    render(<ProfilePage />);
    await userEvent.type(screen.getByLabelText("Username"), "sam");
    await userEvent.click(screen.getByRole("button", { name: "Save username" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("taken");
    expect(screen.getByLabelText("Username")).toHaveValue("sam");
    expect(screen.getByText("No username set")).toBeInTheDocument();
  });
});
