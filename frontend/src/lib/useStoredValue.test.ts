import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStoredValue } from "./useStoredValue";

const parseBool = (raw: string) => (raw === "true" ? true : raw === "false" ? false : null);

afterEach(() => vi.restoreAllMocks());

describe("useStoredValue", () => {
  it("falls back, then stores and reads back a boolean", () => {
    const { result } = renderHook(() => useStoredValue("test.bool.a", true, parseBool));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem("test.bool.a")).toBe("false");
    expect(renderHook(() => useStoredValue("test.bool.a", true, parseBool)).result.current[0]).toBe(false);
  });

  it("ignores an unparseable stored value", () => {
    localStorage.setItem("test.bool.b", "maybe");
    const { result } = renderHook(() => useStoredValue("test.bool.b", true, parseBool));
    expect(result.current[0]).toBe(true);
  });

  it("keeps the value for the session when localStorage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result, unmount } = renderHook(() => useStoredValue("test.bool.c", true, parseBool));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    unmount();
    expect(renderHook(() => useStoredValue("test.bool.c", true, parseBool)).result.current[0]).toBe(false);
  });

  it("follows another tab's write after a local set", () => {
    const { result } = renderHook(() => useStoredValue("test.bool.d", true, parseBool));
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    act(() => {
      localStorage.setItem("test.bool.d", "true");
      window.dispatchEvent(new StorageEvent("storage", { key: "test.bool.d", newValue: "true" }));
    });
    expect(result.current[0]).toBe(true);
  });
});
