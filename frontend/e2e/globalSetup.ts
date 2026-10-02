import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD, STORAGE_STATE, WEB_PORT } from "./account";

// The database is reset and the user seeded by the backend webServer command, because Playwright
// starts web servers before global setup and the file must be gone before the backend opens it.
export default async function globalSetup() {
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  const api = await request.newContext({ baseURL: `http://localhost:${WEB_PORT}` });
  const res = await api.post("/api/v1/auth/login", { data: { email: E2E_EMAIL, password: E2E_PASSWORD } });
  if (!res.ok()) throw new Error(`e2e login failed: ${res.status()} ${await res.text()}`);
  await api.storageState({ path: STORAGE_STATE });
  await api.dispose();
}
