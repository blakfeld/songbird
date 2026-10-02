import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "@playwright/test";
import {
  E2E_EMAIL,
  E2E_PASSWORD,
  HEALTHY_MOCK_KEY,
  KEYLESS_EMAIL,
  KEYLESS_STORAGE_STATE,
  STORAGE_STATE,
  WEB_PORT,
  runUserCommand,
} from "./account";

const ORIGIN = `http://localhost:${WEB_PORT}`;

async function signIn(email: string, statePath: string, saveKey: boolean) {
  // Writes are origin-checked, and a bare API context sends no Origin header.
  const api = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { Origin: ORIGIN } });
  const res = await api.post("/api/v1/auth/login", { data: { email, password: E2E_PASSWORD } });
  if (!res.ok()) throw new Error(`e2e login failed: ${res.status()} ${await res.text()}`);
  if (saveKey) {
    const put = await api.put("/api/v1/account/ai-keys/anthropic", { data: { key: HEALTHY_MOCK_KEY } });
    if (!put.ok()) throw new Error(`e2e key save failed: ${put.status()} ${await put.text()}`);
  }
  await api.storageState({ path: statePath });
  await api.dispose();
}

// The database is reset and the main user seeded by the backend webServer command, because Playwright
// starts web servers before global setup and the file must be gone before the backend opens it.
export default async function globalSetup() {
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  runUserCommand(["create", KEYLESS_EMAIL], E2E_PASSWORD);
  await signIn(E2E_EMAIL, STORAGE_STATE, true);
  await signIn(KEYLESS_EMAIL, KEYLESS_STORAGE_STATE, false);
}
