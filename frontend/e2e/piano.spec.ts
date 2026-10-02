import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { Midi } from "@tonejs/midi";

const notes = (page: Page) => page.getByTestId("note");

// Free steps are searched rather than assumed because the generated notes are not ours to choose.
function findFreeBeat(page: Page) {
  return page.evaluate(() => {
    const cells = [...document.querySelectorAll<HTMLElement>("[data-cell]")].map((el) => {
      const [row, step] = el.dataset.cell!.split(":").map(Number);
      return { row, step, pressed: el.getAttribute("aria-pressed") === "true" };
    });
    const pressed = new Set(cells.filter((c) => c.pressed).map((c) => `${c.row}:${c.step}`));
    const free = cells.find(
      (c) => c.step % 16 <= 12 && [0, 1, 2, 3].every((d) => !pressed.has(`${c.row}:${c.step + d}`)),
    );
    return free ? { row: free.row, step: free.step } : null;
  });
}

test("open the piano, generate, add a note, play, export and reload", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/");
  await page.getByRole("link", { name: "Open the Piano" }).click();
  await expect(page).toHaveURL(/\/instruments\/piano$/);
  await expect(page.getByRole("heading", { name: "Piano", exact: true, level: 1 })).toBeVisible();

  const form = page.getByRole("form", { name: "Generate a pattern" });
  await expect(form.getByRole("combobox", { name: "Measures" })).toBeEnabled();
  await form.getByRole("textbox", { name: "Describe your groove" }).fill("a gentle ballad");
  await form.getByRole("button", { name: "Generate" }).click();

  await expect(notes(page).first()).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Generated");
  await expect(page.getByRole("button", { name: "C4", exact: true })).toBeVisible();
  const generated = await notes(page).count();

  const free = await findFreeBeat(page);
  expect(free, "a free one-beat run exists").not.toBeNull();
  await page.locator(`[data-cell="${free!.row}:${free!.step}"]`).click();
  await expect(notes(page)).toHaveCount(generated + 1);
  await expect(
    page.locator(`[data-testid="note"][data-step="${free!.step}"][data-length="4"][data-velocity="100"]`),
  ).not.toHaveCount(0);

  // Looping is off by default, so Play runs through once and the ruler shows no region.
  await expect(page.getByTestId("loop-region")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Loop playback" })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download MIDI" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^songbird-.+-\d+bpm\.mid$/);
  const midi = new Midi(await readFile((await download.path())!));
  expect(midi.tracks.flatMap((t) => t.notes)).toHaveLength(generated + 1);

  await page.reload();
  await expect(notes(page)).toHaveCount(generated + 1);

  expect(problems).toEqual([]);
});

const SYNTH_INSTRUMENTS = [
  ["electric-piano", "Electric Piano"],
  ["organ", "Organ"],
  ["bass", "Bass"],
  ["synth-lead", "Synth Lead"],
  ["synth-pad", "Synth Pad"],
  ["strings", "Strings"],
  ["pluck", "Pluck"],
] as const;

for (const [id, name] of SYNTH_INSTRUMENTS) {
  test(`${id}: generate, play and stop without console errors`, async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
    page.on("pageerror", (e) => problems.push(e.message));

    await page.goto(`/instruments/${id}`);
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

    const form = page.getByRole("form", { name: "Generate a pattern" });
    await expect(form.getByRole("combobox", { name: "Measures" })).toBeEnabled();
    await form.getByRole("textbox", { name: "Describe your groove" }).fill("a simple line");
    await form.getByRole("button", { name: "Generate" }).click();
    await expect(notes(page).first()).toBeVisible();

    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
    await page.getByRole("button", { name: /Stop/ }).click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

    expect(problems).toEqual([]);
  });
}
