import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { addTrack } from "./studioHelpers";

const CLICK_TRACK = join(__dirname, "media", "click-track.wav");

// Scoped to this file so the other specs keep a browser with no microphone, as a real first visit has.
test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${CLICK_TRACK}`,
    ],
  },
});

// Counts native source starts, which is where a Tone Player ends up, so "it plays" needs no hook in the app.
async function trackSourceStarts(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __starts: number };
    w.__starts = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
      if (this.buffer && this.buffer.length > 1) w.__starts++;
      return start.apply(this, args);
    };
  });
}
const starts = (page: Page) => page.evaluate(() => (window as unknown as { __starts: number }).__starts);

test("record two measures onto an audio track from stopped, undo and redo, then reload and play it", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  await trackSourceStarts(page);

  await page.goto("/studio");
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();
  // A fresh song is one measure long, and a take must still be able to run past that.
  await addTrack(page, "Audio");
  await expect(page.getByRole("group", { name: /^Track 1: Audio/ })).toBeVisible();

  // Pressing Record is the gesture that opens the input, then one bar of count-in, then the take.
  const record = page.getByRole("button", { name: "Record", exact: true });
  await expect(record).not.toHaveAttribute("aria-disabled", "true");
  await record.click();
  await expect(page.getByText("Recording from bar 1.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("recording-overlay")).toBeVisible();
  // Two measures at the default tempo, plus a little so the take's end is past the second barline.
  await page.waitForTimeout(4_300);
  await record.click();

  await expect(page.getByText(/^Recorded Audio Take 1, 2 bars\. Undo removes the take\.$/)).toBeVisible({ timeout: 15_000 });
  const clip = page.getByRole("button", { name: /^Audio Take 1, measure 1 beat 1/ });
  await expect(clip).toBeVisible();
  await expect(page.getByTestId("recording-overlay")).toHaveCount(0);

  await clip.click();
  await expect(page.getByRole("region", { name: /^Editor: Audio Take 1/ }).getByRole("button", { name: "Use Audio Take 1" })).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: /^Audio Take 1, measure/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.getByRole("button", { name: /^Audio Take 1, measure 1 beat 1/ })).toBeVisible();

  // Saves are debounced, so a reload straight after an edit could race the write.
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /^Audio Take 1, measure 1 beat 1/ })).toBeVisible();
  await expect(page.getByText("Audio missing")).toHaveCount(0);
  await page.getByRole("button", { name: /^Audio Take 1, measure 1 beat 1/ }).click();
  await expect(page.getByRole("button", { name: "Use Audio Take 1" })).toBeVisible();

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => starts(page), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  expect(problems).toEqual([]);
});
