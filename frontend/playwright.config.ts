import { defineConfig, devices } from "@playwright/test";

// Distinct from the dev ports so a running `just dev` never gets tested (or killed) by accident.
const API_PORT = 8181;
const WEB_PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // The default HTML reporter serves a report and blocks the process after a failure.
  reporter: [["list"]],
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "cargo run -p api",
      cwd: "../backend",
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      timeout: 300_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      env: {
        SONGBIRD_AI_PROVIDER: "mock",
        SONGBIRD_BIND_ADDR: `127.0.0.1:${API_PORT}`,
        SONGBIRD_MAX_INPUT_TOKENS: "256",
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
