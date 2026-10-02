import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { setCurrentUserId } from "@/lib/auth/currentUser";

// Per-user storage refuses to work without a user, as in the app, where pages render only after sign-in resolves.
beforeEach(() => setCurrentUserId("test-user"));

afterEach(() => {
  cleanup();
});
