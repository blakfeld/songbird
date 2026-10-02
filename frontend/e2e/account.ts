import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const API_PORT = 8181;
export const WEB_PORT = 3100;

export const DB_PATH = join(tmpdir(), "songbird-e2e", "e2e.db");
export const DATABASE_URL = `sqlite://${DB_PATH}?mode=rwc`;
export const STORAGE_STATE = resolve(__dirname, "../.e2e-auth/state.json");

export const E2E_EMAIL = "e2e@example.com";
export const E2E_PASSWORD = "e2e-password-12345";

const BACKEND = resolve(__dirname, "../../backend");

// Runs the operator CLI against the e2e database, the same way an operator would.
export function runUserCommand(args: string[], password?: string) {
  return execFileSync("cargo", ["run", "-q", "-p", "api", "--", "user", ...args], {
    cwd: BACKEND,
    env: { ...process.env, SONGBIRD_DATABASE_URL: DATABASE_URL, SONGBIRD_AI_PROVIDER: "mock" },
    input: password === undefined ? undefined : `${password}\n`,
    encoding: "utf8",
  });
}
