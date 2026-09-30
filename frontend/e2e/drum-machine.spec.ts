import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { Midi } from "@tonejs/midi";
import type { InstrumentInfo } from "../src/generated/InstrumentInfo";

interface NoteSnapshot {
  row: string;
  step: number;
  length: number;
  velocity: number;
}

const notes = (page: Page) => page.getByTestId("note");

async function snapshot(page: Page): Promise<NoteSnapshot[]> {
  const all = await notes(page).evaluateAll((els) =>
    els.map((el) => ({
      row: (el as HTMLElement).dataset.row!,
      step: Number((el as HTMLElement).dataset.step),
      length: Number((el as HTMLElement).dataset.length),
      velocity: Number((el as HTMLElement).dataset.velocity),
    })),
  );
  return all.sort((a, b) => a.step - b.step || a.row.localeCompare(b.row));
}

// Finds a spot with four free steps in one row so the resize scenario cannot be blocked by generated notes.
async function findFreeRun(page: Page) {
  return page.evaluate(() => {
    const cells = [...document.querySelectorAll<HTMLElement>("[data-cell]")].map((el) => {
      const [row, step] = el.dataset.cell!.split(":").map(Number);
      return { row, step, pressed: el.getAttribute("aria-pressed") === "true" };
    });
    const pressed = new Set(cells.filter((c) => c.pressed).map((c) => `${c.row}:${c.step}`));
    const free = cells.find(
      (c) =>
        c.step % 16 <= 8 &&
        c.step >= 32 &&
        [0, 1, 2, 3, 4].every((d) => !pressed.has(`${c.row}:${c.step + d}`)),
    );
    return free ? `${free.row}:${free.step}` : null;
  });
}

test("generate, edit, persist and export a drum pattern", async ({ page }) => {
  // Hydration mismatches surface only as console errors, so any error fails the run.
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  const instruments: InstrumentInfo[] = await (await page.request.get("/api/v1/instruments")).json();
  const drums = instruments.find((i) => i.id === "drums")!;

  await page.goto("/drum-machine");
  const form = page.getByRole("form", { name: "Generate a pattern" });
  const prompt = form.getByRole("textbox", { name: "Describe your groove" });
  const generate = form.getByRole("button", { name: "Generate" });
  await expect(form.getByRole("combobox", { name: "Measures" })).toBeEnabled();

  await prompt.fill("drum groove ".repeat(100));
  await expect(form.getByText(/Too long/)).toBeVisible();
  await expect(generate).toBeDisabled();

  await prompt.fill("laid-back boom bap with ghost-note snares");
  await expect(generate).toBeEnabled();
  await form.getByRole("combobox", { name: "Measures" }).selectOption("16");
  await generate.click();

  await expect(notes(page).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Kick, measure 16, step 16" })).toBeAttached();
  await expect(page.getByRole("status")).toContainText("Generated");

  const generated = await notes(page).count();

  const run = await findFreeRun(page);
  expect(run, "a free four-step run exists in a 16-measure pattern").not.toBeNull();
  const [row, step] = run!.split(":").map(Number);
  const cell = page.locator(`[data-cell="${row}:${step}"]`);

  await cell.click();
  await expect(notes(page)).toHaveCount(generated + 1);
  const bar = page.locator(`[data-testid="note"][data-row="${drums.rows[row].id}"][data-step="${step}"]`);
  await bar.click();
  await expect(notes(page)).toHaveCount(generated);

  await cell.click();
  await expect(notes(page)).toHaveCount(generated + 1);

  const handle = bar.getByTestId("note-resize");
  await bar.hover();
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 3 * 28, y, { steps: 6 });
  await page.mouse.up();
  await expect(bar).toHaveAttribute("data-length", "4");

  await cell.focus();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(bar).toHaveAttribute("data-velocity", "90");

  const edited = await snapshot(page);
  expect(edited).toHaveLength(generated + 1);

  await page.reload();
  await expect(notes(page).first()).toBeVisible();
  expect(await snapshot(page)).toEqual(edited);

  // Only transport state is asserted; audio output is not observable here.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  const tempo = Number(await page.getByRole("spinbutton", { name: "Tempo", exact: true }).inputValue());
  const swing = Number(
    (await page.getByRole("slider", { name: "Swing" }).getAttribute("aria-valuetext"))!.split(" ")[0],
  ) / 100;

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download MIDI" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^songbird-.+-\d+bpm\.mid$/);
  const midi = new Midi(await readFile((await download.path())!));

  const midiNote = Object.fromEntries(drums.rows.map((r) => [r.id, r.midi_note]));

  expect(midi.header.ppq).toBe(480);
  expect(midi.header.tempos[0].bpm).toBeCloseTo(tempo, 1);

  const ticksAt = (s: number) => Math.round((s + (s % 2 === 1 ? swing : 0)) * 120);
  const expected = edited
    .map((n) => ({
      midi: midiNote[n.row],
      ticks: ticksAt(n.step),
      durationTicks: ticksAt(n.step + n.length) - ticksAt(n.step),
      velocity: n.velocity,
    }))
    .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
  const actual = midi.tracks
    .flatMap((t) => t.notes)
    .map((n) => ({
      midi: n.midi,
      ticks: n.ticks,
      durationTicks: n.durationTicks,
      velocity: Math.round(n.velocity * 127),
    }))
    .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
  expect(actual).toEqual(expected);

  const sec = (ticks: number) => (ticks / 480) * (60 / tempo);
  for (const n of midi.tracks.flatMap((t) => t.notes)) {
    expect(n.time).toBeCloseTo(sec(n.ticks), 2);
    expect(n.duration).toBeCloseTo(sec(n.durationTicks), 2);
  }

  expect(problems).toEqual([]);
});

// Only the first measures are draggable here because later ones lie beyond the viewport.
async function dragAcrossMeasures(page: Page, from: number, to: number) {
  // The ruler can sit below the fold, where raw mouse coordinates would miss it.
  await page.getByTestId("loop-hit-layer").scrollIntoViewIfNeeded();
  const box = (await page.getByTestId("loop-hit-layer").boundingBox())!;
  // The hit layer spans the whole ruler, so dividing by the blank grid's length gives the snap width.
  const w = box.width / 4;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + (from - 0.5) * w, y);
  await page.mouse.down();
  await page.mouse.move(box.x + (to - 0.5) * w, y, { steps: 6 });
  await page.mouse.up();
}

test("draw, toggle and persist a loop region, and play once when looping is off", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/drum-machine");
  await page.getByRole("button", { name: "Start with a blank grid" }).click();
  const region = page.getByTestId("loop-region");
  const toggle = page.getByRole("button", { name: "Loop playback" });
  await expect(region).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // With no region the toggle loops the whole pattern and must not draw one.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(region).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await dragAcrossMeasures(page, 1, 2);
  await expect(region).toHaveAttribute("data-start", "1");
  await expect(region).toHaveAttribute("data-end", "2");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await region.click();
  await expect(region).toHaveAttribute("data-enabled", "false");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(region).toHaveAttribute("data-enabled", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await page.reload();
  await expect(region).toHaveAttribute("data-start", "1");
  await expect(region).toHaveAttribute("data-end", "2");
  await expect(region).toHaveAttribute("data-enabled", "false");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // Four measures at the default tempo take about eight seconds; it must end without pressing Stop.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible({ timeout: 30_000 });

  expect(problems).toEqual([]);
});

test("create and extend the first loop region from the keyboard", async ({ page }) => {
  await page.goto("/drum-machine");
  await page.getByRole("button", { name: "Start with a blank grid" }).click();
  const region = page.getByTestId("loop-region");
  await expect(region).toHaveCount(0);

  // An empty ruler has nothing to focus, so this button is the only keyboard route to a first region.
  const setRegion = page.getByRole("button", { name: "Set loop region" });
  await page.getByRole("button", { name: "Loop playback" }).focus();
  for (let i = 0; i < 40 && !(await setRegion.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(setRegion).toBeFocused();
  await expect(setRegion).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("slider", { name: "Loop region end" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(region).toHaveAttribute("data-start", "1");
  await expect(region).toHaveAttribute("data-end", "2");
  await expect(page.getByRole("button", { name: "Loop playback" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Stop/ })).toHaveCount(0);
});
