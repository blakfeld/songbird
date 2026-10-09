import http from "node:http";
import { pathToFileURL } from "node:url";

// Sits between the 150 s default stream deadline and the 200 s kill_timeout, leaving
// the last 10 s for Litestream's final sync on the API side.
export const DRAIN_CAP_MS = 190_000;

// A second signal must not shorten the drain: Fly sends one signal then SIGKILL, and a
// terminal's Ctrl-C is often delivered twice (shell plus parent).
export function drainOnSignal({ server, capMs = DRAIN_CAP_MS, exit = process.exit, proc = process }) {
  let draining = false;
  const onSignal = () => {
    if (draining) return;
    draining = true;
    setTimeout(() => exit(0), capMs);
    // Next's own nextServer.close(), which drains after()/ISR/cache-write work, is skipped on
    // purpose: we hold no handle to Next's internal server. Unsafe once routes use after() or revalidation.
    server.close(() => exit(0));
  };
  proc.on("SIGTERM", onSignal);
  proc.on("SIGINT", onSignal);
  return onSignal;
}

// Next's standalone server.js never exposes the http.Server it creates, and calling
// startServer ourselves would duplicate the build-generated config in server.js.
function captureServer() {
  const original = http.Server.prototype.listen;
  const captured = new Promise((resolve) => {
    http.Server.prototype.listen = function listen(...args) {
      http.Server.prototype.listen = original;
      resolve(this);
      return original.apply(this, args);
    };
  });
  return { captured, restore: () => (http.Server.prototype.listen = original) };
}

export const CAPTURE_TIMEOUT_MS = 30_000;

export async function start({
  importServer = () => import("./server.js"),
  captureTimeoutMs = CAPTURE_TIMEOUT_MS,
  ...drainOptions
} = {}) {
  // With this unset Next installs its own handlers that process.exit immediately.
  process.env.NEXT_MANUAL_SIG_HANDLE = "1";
  const { captured, restore } = captureServer();
  await importServer();
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), captureTimeoutMs);
  });
  const server = await Promise.race([captured, timedOut]);
  clearTimeout(timer);
  if (server) {
    drainOnSignal({ server, ...drainOptions });
    return;
  }
  restore();
  // Without a server handle and with Next's handlers disabled, signals would otherwise be ignored
  // until SIGKILL, so fall back to the immediate exit Next would have done and say so loudly.
  console.error(
    "server-wrapper: Next never called listen(); graceful drain is unavailable and signals exit immediately.",
  );
  const { exit = process.exit, proc = process } = drainOptions;
  proc.on("SIGTERM", () => exit(0));
  proc.on("SIGINT", () => exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
