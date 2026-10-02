import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import type { InstrumentInfo } from "../src/generated/InstrumentInfo";
import { installFakeMidi, sendNote } from "./fakeMidi";
import { addTrack, newSong } from "./studioHelpers";

async function connectMidi(page: Page) {
  await page.getByRole("button", { name: "Connect MIDI" }).click();
  await expect(page.getByRole("button", { name: /^MIDI input:/ })).toBeVisible();
  // The menu opens on grant and would cover the transport.
  await page.keyboard.press("Escape");
}

// Count-in only adds a bar of waiting before the take starts, which these flows don't exercise.
async function disableCountIn(page: Page) {
  const countIn = page.getByRole("button", { name: "Count-in" });
  if ((await countIn.getAttribute("aria-pressed")) === "true") await countIn.click();
  await expect(countIn).toHaveAttribute("aria-pressed", "false");
}

test("record a looping drum take from a MIDI keyboard and find it after a reload", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await installFakeMidi(page);
  const instruments: InstrumentInfo[] = await (await page.request.get("/api/v1/instruments")).json();
  const [kick, snare, third] = instruments.find((i) => i.id === "drums")!.rows;

  await page.goto("/drum-machine");
  await page.getByRole("button", { name: "Start with a blank grid" }).click();
  await connectMidi(page);
  await disableCountIn(page);

  const loop = page.getByRole("button", { name: "Loop playback" });
  if ((await loop.getAttribute("aria-pressed")) !== "true") await loop.click();
  await expect(loop).toHaveAttribute("aria-pressed", "true");

  const record = page.getByRole("button", { name: "Record" });
  await expect(record).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
  await record.click();
  await expect(record).toHaveText("Recording");

  // Sent before the transport is audibly running, which must map to the first step rather than be dropped.
  await sendNote(page, kick.midi_note, 40);
  await page.waitForTimeout(450);
  for (const row of [snare, third]) {
    await sendNote(page, row.midi_note, 40);
    await page.waitForTimeout(450);
  }
  await record.click();
  await expect(page.getByRole("status")).toContainText(/Recorded \d+ notes?/);

  const recorded = async () =>
    page.getByTestId("note").evaluateAll((els) => [...new Set(els.map((el) => (el as HTMLElement).dataset.row))].sort());
  const expected = [kick.id, snare.id, third.id].sort();
  await expect.poll(recorded).toEqual(expected);
  await expect(
    page.locator(`[data-testid="note"][data-row="${kick.id}"][data-step="0"]`),
  ).toHaveCount(1);
  const before = await page.getByTestId("note").count();

  await page.reload();
  await expect(page.getByTestId("note").first()).toBeVisible();
  await expect(page.getByTestId("note")).toHaveCount(before);
  expect(await recorded()).toEqual(expected);
  expect(problems).toEqual([]);
});

test("record over empty studio lane space, then undo the take", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await installFakeMidi(page);
  await page.goto("/studio");
  await newSong(page, "MIDI Take Song");

  await addTrack(page, "Piano");
  const track = page.getByRole("group", { name: /^Track 1: Piano/ });
  const clips = track.getByRole("button", { name: /^Piano 1, measures? \d+/ });
  await expect(clips).toHaveCount(0);

  await connectMidi(page);
  await disableCountIn(page);

  const record = page.getByRole("button", { name: "Record" });
  await expect(record).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
  await record.click();
  await expect(record).toHaveText("Recording");

  await sendNote(page, 60, 300);
  await page.waitForTimeout(300);
  await record.click();
  await expect(page.getByRole("status").filter({ hasText: /Recorded \d+ notes?/ })).toBeVisible();
  await expect(clips).toHaveCount(1);

  // Focus must leave the Record button so the shortcut reaches the page rather than a control.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(clips).toHaveCount(0);
  expect(problems).toEqual([]);
});
