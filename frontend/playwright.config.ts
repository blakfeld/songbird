import { dirname } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { API_PORT, DATABASE_URL, DB_PATH, E2E_EMAIL, E2E_PASSWORD, MASTER_KEYS, STORAGE_STATE, WEB_PORT } from "./e2e/account";

// Playwright starts web servers before global setup, so the fresh database and the seeded user are
// made here, ahead of the backend opening the file. Ports are distinct from the dev ports so a
// running `just dev` is never tested (or killed) by accident.
const BACKEND_COMMAND = [
  `rm -f '${DB_PATH}' '${DB_PATH}-wal' '${DB_PATH}-shm'`,
  `mkdir -p '${dirname(DB_PATH)}'`,
  `printf '%s\\n' '${E2E_PASSWORD}' | cargo run -q -p api -- user create '${E2E_EMAIL}'`,
  "exec cargo run -p api",
].join(" && ");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // The specs share one account and its server-side songs, so a second worker would delete
  // songs out from under a test running in the first.
  workers: 1,
  // The default HTML reporter serves a report and blocks the process after a failure.
  reporter: [["list"]],
  retries: process.env.CI ? 1 : 0,
  globalSetup: "./e2e/globalSetup.ts",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    storageState: STORAGE_STATE,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: BACKEND_COMMAND,
      cwd: "../backend",
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      timeout: 300_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      env: {
        // Production is the backend's default and rejects the mock provider.
        SONGBIRD_ENV: "development",
        SONGBIRD_AI_PROVIDER: "user-mock",
        SONGBIRD_MASTER_KEYS: MASTER_KEYS,
        SONGBIRD_BIND_ADDR: `127.0.0.1:${API_PORT}`,
        SONGBIRD_MAX_INPUT_TOKENS: "256",
        SONGBIRD_DATABASE_URL: DATABASE_URL,
        SONGBIRD_COOKIE_SECURE: "false",
        // Only configured origins pass the write check, and the browser sends the frontend's.
        SONGBIRD_CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
        // All specs share one user, so the default AI limits would throttle the generation flows.
        SONGBIRD_AI_REQUESTS_PER_MINUTE: "600",
        SONGBIRD_AI_REQUESTS_PER_DAY: "100000",
      },
    },
    {
      command: `pnpm exec next dev -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      env: {
        SONGBIRD_API_URL: `http://127.0.0.1:${API_PORT}`,
        NEXT_DIST_DIR: ".next-e2e",
      },
    },
  ],
});
