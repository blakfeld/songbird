import { renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStoredHeight } from "./useStoredHeight";

afterEach(() => vi.restoreAllMocks());

describe("useStoredHeight", () => {
  it("persists to localStorage and reads it back", () => {
    const first = renderHook(() => useStoredHeight("test.height.a"));
    act(() => first.result.current[1](300));
    expect(localStorage.getItem("test.height.a")).toBe("300");
  });

  it("still remembers the height for the session when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result, unmount } = renderHook(() => useStoredHeight("test.height.b"));
    expect(result.current[0]).toBeNull();
    act(() => result.current[1](280));
    expect(result.current[0]).toBe(280);
    unmount();
    expect(renderHook(() => useStoredHeight("test.height.b")).result.current[0]).toBe(280);
    act(() => result.current[1](null));
  });
});
