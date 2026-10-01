import type { Page } from "@playwright/test";

declare global {
  interface Window {
    __midi: {
      send(inputId: string, bytes: number[]): void;
      connect(id: string, name?: string): void;
      disconnect(id: string): void;
    };
  }
}

export const KEYBOARD_ID = "e2e-keyboard";

// Runs in the page before any app code, so it cannot import anything and must stay self-contained.
export async function installFakeMidi(page: Page) {
  await page.addInitScript((keyboardId) => {
    type Listener = ((e: { data: Uint8Array; timeStamp: number }) => void) | null;
    interface Input {
      id: string;
      name: string;
      type: "input";
      state: "connected" | "disconnected";
      onmidimessage: Listener;
    }
    const inputs = new Map<string, Input>();
    const access = { inputs, onstatechange: null as (() => void) | null };
    const add = (id: string, name: string) =>
      inputs.set(id, { id, name, type: "input", state: "connected", onmidimessage: null });
    add(keyboardId, "E2E Keyboard");

    Object.defineProperty(navigator, "requestMIDIAccess", {
      configurable: true,
      value: () => Promise.resolve(access),
    });
    window.__midi = {
      // Stamped from the page clock because the app maps timestamps to steps with performance.now().
      send(inputId, bytes) {
        inputs.get(inputId)?.onmidimessage?.({
          data: new Uint8Array(bytes),
          timeStamp: performance.now(),
        });
      },
      connect(id, name = id) {
        const existing = inputs.get(id);
        if (existing) existing.state = "connected";
        else add(id, name);
        access.onstatechange?.();
      },
      disconnect(id) {
        const input = inputs.get(id);
        if (input) input.state = "disconnected";
        access.onstatechange?.();
      },
    };
  }, KEYBOARD_ID);
}

export async function sendNote(page: Page, note: number, heldMs = 60, velocity = 100) {
  await page.evaluate(([n, v]) => window.__midi.send("e2e-keyboard", [0x90, n, v]), [note, velocity]);
  await page.waitForTimeout(heldMs);
  await page.evaluate((n) => window.__midi.send("e2e-keyboard", [0x80, n, 0]), note);
}
