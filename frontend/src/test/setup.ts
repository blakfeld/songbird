import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { setCurrentUserId } from "@/lib/auth/currentUser";

// Per-user storage refuses to work without a user, as in the app, where pages render only after sign-in resolves.
beforeEach(() => setCurrentUserId("test-user"));

// CodeMirror measures text ranges in a later animation frame, and jsdom has no layout, so without these the
// measure throws as an unhandled error, which fails the run when it lands before the test file is torn down.
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

afterEach(() => {
  cleanup();
});
