// @vitest-environment node
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { DRAIN_CAP_MS, drainOnSignal, start } from "../../server-wrapper.mjs";

const require = createRequire(import.meta.url);

function fakeServer() {
  let finish: () => void = () => {};
  return {
    close: vi.fn((cb: () => void) => {
      finish = cb;
    }),
    finish: () => finish(),
  };
}

describe("drainOnSignal", () => {
  it("closes the server and exits 0 once the drain completes", () => {
    const server = fakeServer();
    const proc = new EventEmitter();
    const exit = vi.fn();
    drainOnSignal({ server, proc, exit, capMs: 1000 });

    proc.emit("SIGTERM");
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    server.finish();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("handles SIGINT the same way", () => {
    const server = fakeServer();
    const proc = new EventEmitter();
    drainOnSignal({ server, proc, exit: vi.fn(), capMs: 1000 });
    proc.emit("SIGINT");
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it("exits 0 when the cap expires before the drain finishes", () => {
    vi.useFakeTimers();
    try {
      const server = fakeServer();
      const proc = new EventEmitter();
      const exit = vi.fn();
      drainOnSignal({ server, proc, exit, capMs: 5000 });

      proc.emit("SIGTERM");
      vi.advanceTimersByTime(4999);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart or shorten the drain on a second signal", () => {
    vi.useFakeTimers();
    try {
      const server = fakeServer();
      const proc = new EventEmitter();
      const exit = vi.fn();
      drainOnSignal({ server, proc, exit, capMs: 5000 });

      proc.emit("SIGTERM");
      vi.advanceTimersByTime(3000);
      proc.emit("SIGTERM");
      proc.emit("SIGINT");
      expect(server.close).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2000);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the drain at 190 s by default", () => {
    expect(DRAIN_CAP_MS).toBe(190_000);
  });
});

describe("start", () => {
  it("sets NEXT_MANUAL_SIG_HANDLE before server.js is imported", async () => {
    delete process.env.NEXT_MANUAL_SIG_HANDLE;
    let seen: string | undefined;
    let created: http.Server | undefined;
    await start({
      importServer: async () => {
        seen = process.env.NEXT_MANUAL_SIG_HANDLE;
        created = http.createServer().listen(0, "127.0.0.1");
      },
      proc: new EventEmitter(),
      exit: vi.fn(),
    });
    created?.close();
    expect(seen).toBe("1");
  });

  it("closes the server that Next created when a signal arrives", async () => {
    const proc = new EventEmitter();
    const exit = vi.fn();
    let created: http.Server | undefined;
    await start({
      importServer: async () => {
        created = http.createServer().listen(0, "127.0.0.1");
      },
      proc,
      exit,
    });
    const close = vi.spyOn(created!, "close");
    proc.emit("SIGTERM");
    expect(close).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("reports loudly and still exits on signals when Next never listens", async () => {
    const proc = new EventEmitter();
    const exit = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await start({ importServer: async () => {}, proc, exit, captureTimeoutMs: 10 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("never called listen"));
    proc.emit("SIGTERM");
    expect(exit).toHaveBeenCalledWith(0);
    error.mockRestore();
  });
});

describe("Next's signal handling guard", () => {
  it("still honours NEXT_MANUAL_SIG_HANDLE", () => {
    const source = readFileSync(require.resolve("next/dist/server/lib/start-server.js"), "utf8");
    expect(source).toContain("process.env.NEXT_MANUAL_SIG_HANDLE");
  });
});
