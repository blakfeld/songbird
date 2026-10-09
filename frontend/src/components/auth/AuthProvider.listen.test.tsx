import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthProvider";

const pathname = vi.hoisted(() => ({ value: "/listen/abc" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }));

const me = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/client", () => ({ me }));

function Probe() {
  return <p>{useAuth().user ? "account shown" : "no account"}</p>;
}

afterEach(() => {
  cleanup();
  me.mockReset();
});

describe("AuthProvider on a listen page", () => {
  it("renders at once without asking who the visitor is", () => {
    me.mockRejectedValue(new Error("must not be called"));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByText("no account")).toBeInTheDocument();
    expect(me).not.toHaveBeenCalled();
  });

  it("still checks the session on other pages", () => {
    pathname.value = "/studio";
    me.mockReturnValue(new Promise(() => {}));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(me).toHaveBeenCalled();
    pathname.value = "/listen/abc";
  });
});
