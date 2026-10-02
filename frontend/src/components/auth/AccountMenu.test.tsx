import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentUserId, setCurrentUserId } from "@/lib/auth/currentUser";
import { logout, me } from "@/lib/auth/client";
import { signOutLocally } from "@/lib/auth/signOut";
import { createServerSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import { createFakeProjectsApi } from "@/test/fakeProjectsApi";
import { AccountMenu } from "./AccountMenu";
import { AuthProvider } from "./AuthProvider";

vi.mock("@/lib/auth/client", () => ({ me: vi.fn(), logout: vi.fn() }));
vi.mock("@/lib/auth/signOut", () => ({ signOutLocally: vi.fn(), isSigningOut: () => false }));

const user = { id: "u1", email: "ana@example.com" };
let library: SongLibrary;
let fake: ReturnType<typeof createFakeProjectsApi>;
let order: string[];

function renderMenu() {
  render(
    <AuthProvider>
      <AccountMenu library={library} />
    </AuthProvider>,
  );
}

const openMenu = async () => {
  await userEvent.click(await screen.findByRole("button", { name: "Account: ana@example.com" }));
};
const clickLogOut = () => userEvent.click(screen.getByRole("menuitem", { name: "Log out" }));

beforeEach(() => {
  vi.mocked(me).mockReset().mockResolvedValue(user);
  order = [];
  vi.mocked(logout).mockReset().mockImplementation(async () => void order.push("logout"));
  vi.mocked(signOutLocally).mockReset().mockImplementation(async () => void order.push("signOut"));
  fake = createFakeProjectsApi();
  library = createServerSongLibrary(fake.api);
  vi.spyOn(library, "flush").mockImplementation(async () => void order.push("flush"));
});

describe("AuthProvider", () => {
  it("loads the user once and holds the page until then", async () => {
    setCurrentUserId(null);
    let resolve!: (u: typeof user) => void;
    vi.mocked(me).mockReturnValue(new Promise((r) => (resolve = r)));
    render(
      <AuthProvider>
        <p>page content</p>
      </AuthProvider>,
    );
    expect(screen.queryByText("page content")).not.toBeInTheDocument();
    expect(getCurrentUserId()).toBeNull();
    resolve(user);
    expect(await screen.findByText("page content")).toBeInTheDocument();
    // Per-user stores key off this id, so it has to be set before the children first render.
    expect(getCurrentUserId()).toBe("u1");
    expect(me).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when the user cannot be loaded", async () => {
    vi.mocked(me).mockRejectedValueOnce(new Error("offline"));
    render(
      <AuthProvider>
        <p>page content</p>
      </AuthProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't check your sign-in/);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("page content")).toBeInTheDocument();
  });
});

describe("AccountMenu", () => {
  it("shows the signed-in email", async () => {
    renderMenu();
    await openMenu();
    expect(screen.getByText("Signed in as")).toBeInTheDocument();
    expect(screen.getAllByText("ana@example.com").length).toBeGreaterThan(0);
  });

  it("logs out by flushing the pending save, then calling logout, then clearing local state", async () => {
    renderMenu();
    await openMenu();
    await clickLogOut();
    await waitFor(() => expect(order).toEqual(["flush", "logout", "signOut"]));
  });

  it("still clears local state when the logout request fails", async () => {
    vi.mocked(logout).mockRejectedValue(new Error("offline"));
    renderMenu();
    await openMenu();
    await clickLogOut();
    await waitFor(() => expect(signOutLocally).toHaveBeenCalled());
  });

  it("ignores a second click while logging out", async () => {
    let release!: () => void;
    vi.mocked(library.flush).mockImplementation(() => new Promise<void>((r) => (release = r)));
    renderMenu();
    await openMenu();
    await clickLogOut();
    const item = await screen.findByRole("menuitem", { name: "Logging out…" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(item);
    release();
    await waitFor(() => expect(signOutLocally).toHaveBeenCalledTimes(1));
    expect(library.flush).toHaveBeenCalledTimes(1);
  });

  describe("when the latest changes could not be saved", () => {
    beforeEach(() => {
      library.status.setState({ ok: false, message: "not saved" });
    });

    it("warns instead of logging out, and Stay signed in keeps the session", async () => {
      renderMenu();
      await openMenu();
      await clickLogOut();
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("Your latest changes aren't saved");
      expect(screen.getByRole("button", { name: "Stay signed in" })).toHaveFocus();
      expect(logout).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Stay signed in" }));
      expect(logout).not.toHaveBeenCalled();
      expect(signOutLocally).not.toHaveBeenCalled();
    });

    it("logs out after Log out anyway", async () => {
      renderMenu();
      await openMenu();
      await clickLogOut();
      await userEvent.click(await screen.findByRole("button", { name: "Log out anyway" }));
      await waitFor(() => expect(order).toEqual(["flush", "logout", "signOut"]));
    });
  });

  it("treats an unresolved save conflict as unsaved work", async () => {
    library.status.setState({ conflict: true });
    renderMenu();
    await openMenu();
    await clickLogOut();
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  });

  it("logs out without a prompt when everything is saved", async () => {
    const song = await library.create(newSongWithTracks());
    expect(song.id).toBeTruthy();
    renderMenu();
    await openMenu();
    await clickLogOut();
    await waitFor(() => expect(signOutLocally).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
