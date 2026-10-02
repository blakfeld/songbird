import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigateTo } from "@/lib/auth/navigation";
import { LoginForm } from "./LoginForm";

vi.mock("@/lib/auth/navigation", () => ({ navigateTo: vi.fn() }));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const failure = (status: number, code: string) => json({ error: { code, message: "server text" } }, status);

interface Handlers {
  me: () => Response | Promise<Response>;
  login: () => Response | Promise<Response>;
}

function stubApi(overrides: Partial<Handlers> = {}) {
  const handlers: Handlers = {
    me: () => failure(401, "unauthenticated"),
    login: () => json({ user: { id: "u1", email: "a@b.c" } }),
    ...overrides,
  };
  const fn = vi.fn<typeof fetch>(async (input) => (String(input).endsWith("/me") ? handlers.me() : handlers.login()));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const email = () => screen.getByLabelText("Email");
const password = () => screen.getByLabelText("Password");

async function signIn(mail = "a@b.c", pw = "secret") {
  await userEvent.type(email(), mail);
  await userEvent.type(password(), pw);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
  localStorage.setItem("songbird.studio.lastSong.u1", "s1");
  vi.mocked(navigateTo).mockClear();
  window.history.replaceState(null, "", "/login");
});
afterEach(() => vi.unstubAllGlobals());

describe("Login page", () => {
  it("has email and password fields and a Sign in button, with email focused", () => {
    stubApi();
    render(<LoginForm />);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(email()).toHaveFocus();
    expect(email()).toHaveAttribute("type", "email");
    expect(password()).toHaveAttribute("type", "password");
  });

  it("signs in and goes to the home page when there is no return target", async () => {
    const fn = stubApi();
    render(<LoginForm />);
    await signIn(" a@b.c ", " secret ");
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/"));
    const login = fn.mock.calls.find(([url]) => String(url).endsWith("/login"))!;
    // The email is trimmed but the password is sent exactly as typed.
    expect(JSON.parse(login[1]!.body as string)).toEqual({ email: "a@b.c", password: " secret " });
  });

  it("returns to the page the user asked for", async () => {
    window.history.replaceState(null, "", "/login?next=/studio");
    stubApi();
    render(<LoginForm />);
    await signIn();
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/studio"));
  });

  it("keeps the query and fragment of the return target", async () => {
    window.history.replaceState(null, "", "/login?next=%2Fstudio%3Fsong%3D1%23mixer");
    stubApi();
    render(<LoginForm />);
    await signIn();
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/studio?song=1#mixer"));
  });

  it.each([
    ["an off-site URL", "https://evil.example"],
    ["a backslash target", "/\\evil.example"],
    ["a script URL", "javascript:alert(1)"],
  ])("ignores %s", async (_, next) => {
    window.history.replaceState(null, "", `/login?next=${encodeURIComponent(next)}`);
    stubApi();
    render(<LoginForm />);
    await signIn();
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/"));
  });

  it.each(["/%5Cevil.example", "/%09/evil.example"])("keeps an encoded target %s on this site", async (next) => {
    window.history.replaceState(null, "", `/login?next=${next}`);
    stubApi();
    render(<LoginForm />);
    await signIn();
    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    const target = vi.mocked(navigateTo).mock.calls[0][0];
    expect(new URL(target, window.location.origin).origin).toBe(window.location.origin);
  });

  it("shows the incorrect-credentials message, keeps the email, and clears the password", async () => {
    stubApi({ login: () => failure(401, "invalid_credentials") });
    render(<LoginForm />);
    await signIn("a@b.c", "wrong");
    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect");
    expect(email()).toHaveValue("a@b.c");
    expect(password()).toHaveValue("");
    expect(password()).toHaveFocus();
    expect(email()).toBeInvalid();
    expect(password()).toBeInvalid();
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("does not run the app-wide sign-out for a 401 on this page", async () => {
    stubApi({ login: () => failure(401, "invalid_credentials") });
    render(<LoginForm />);
    await signIn();
    await screen.findByRole("alert");
    // The initial me() also got a 401, and neither may clear storage or navigate.
    expect(localStorage.getItem("songbird.studio.lastSong.u1")).toBe("s1");
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it.each([
    ["too_many_requests", 429, /Try again in a few minutes/],
    ["server_busy", 503, /busy right now.*Try again/],
  ])("asks the user to try later on %s and keeps the entered values", async (code, status, text) => {
    stubApi({ login: () => failure(status, code) });
    render(<LoginForm />);
    await signIn("a@b.c", "secret");
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(email()).toHaveValue("a@b.c");
    expect(password()).toHaveValue("secret");
  });

  it("shows a generic message when the service cannot be reached", async () => {
    stubApi({
      login: () => {
        throw new TypeError("offline");
      },
    });
    render(<LoginForm />);
    await signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't sign in. Check your connection and try again.");
  });

  it("disables Sign in and ignores a second submit while the request is in flight", async () => {
    let finish!: (r: Response) => void;
    const fn = stubApi({ login: () => new Promise<Response>((r) => (finish = r)) });
    render(<LoginForm />);
    await signIn();
    const button = screen.getByRole("button", { name: "Signing in…" });
    expect(button).toBeDisabled();
    await userEvent.type(password(), "{Enter}");
    expect(fn.mock.calls.filter(([url]) => String(url).endsWith("/login"))).toHaveLength(1);
    finish(json({ user: { id: "u1", email: "a@b.c" } }));
    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    // Stays disabled until the page is replaced.
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
  });

  it("re-enables the button after a failure", async () => {
    stubApi({ login: () => failure(401, "invalid_credentials") });
    render(<LoginForm />);
    await signIn();
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("sends a user who is already signed in to the home page", async () => {
    stubApi({ me: () => json({ user: { id: "u1", email: "a@b.c" } }) });
    render(<LoginForm />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/"));
  });

  it("explains that accounts come from the administrator", () => {
    stubApi();
    render(<LoginForm />);
    expect(screen.getByText(/set up by your Songbird administrator/)).toBeInTheDocument();
  });
});
