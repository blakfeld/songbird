import { expect, test } from "@playwright/test";

test("build a song across tracks, mix it, reload and find it unchanged", async ({ page }) => {
  // Hydration mismatches surface only as console errors, so any error fails the run.
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();

  await page.getByRole("button", { name: "Songs" }).click();
  const library = page.getByRole("dialog", { name: "Songs" });
  await library.getByRole("button", { name: "New song…" }).click();
  const create = page.getByRole("dialog", { name: "New song" });
  await create.getByRole("textbox", { name: "Name" }).fill("E2E Song");
  await create.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("button", { name: "Rename song E2E Song" })).toBeVisible();

  // Only drums and piano exist today, so the bass part is a second piano track renamed to Bass.
  await page.getByRole("button", { name: "Add track" }).click();
  await page.getByRole("menuitem", { name: "Piano" }).click();
  await expect(page.getByRole("group", { name: "Track 3: Piano 2" })).toBeVisible();
  await page.getByRole("button", { name: "Select Piano 2 track (Piano)" }).last().dblclick();
  await page.getByRole("textbox", { name: "Track name Piano 2" }).fill("Bass");
  await page.keyboard.press("Enter");
  const bass = page.getByRole("group", { name: "Track 3: Bass" });
  await expect(bass).toBeVisible();

  // Room for three 4-measure clips.
  const length = page.getByRole("spinbutton", { name: "Length" });
  await length.fill("16");
  await length.press("Enter");

  await bass.getByTestId("clip-lane").dblclick({ position: { x: 10, y: 20 } });
  const first = bass.getByRole("button", { name: "Bass 1, measures 1 to 4" });
  await expect(first).toBeVisible();
  const editor = page.getByRole("region", { name: "Editor: Bass 1 on Bass" });
  await editor.getByRole("button", { name: "C2, measure 1, step 1", exact: true }).click();
  await editor.getByRole("button", { name: "C2, measure 2, step 1", exact: true }).click();
  await expect(editor.getByTestId("note")).toHaveCount(2);

  // A plain vertical drag moves the note to another row and keeps its step.
  const rowsOf = () => editor.getByTestId("note").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.row));
  const before = await rowsOf();
  const target = editor.getByTestId("note").first();
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(rowsOf).not.toEqual(before);
  await expect(editor.getByTestId("note")).toHaveCount(2);

  // The copies must stay linked so the unique edit below proves it isolates a single clip.
  await first.focus();
  await page.keyboard.press("Control+d");
  // Focus follows the new clip asynchronously; pressing again earlier would duplicate the first clip.
  await expect(bass.getByRole("button", { name: /^Bass 1, measures 5 to 8/ })).toBeFocused();
  await page.keyboard.press("Control+d");
  await expect(bass.getByRole("button", { name: "Bass 1, measures 9 to 12, linked, 3 clips" })).toBeVisible();

  // Making the last copy unique and editing it must leave the linked clips alone.
  await editor.getByRole("button", { name: /^Clip actions for/ }).click();
  await page.getByRole("menuitem", { name: "Make unique" }).click();
  const unique = page.getByRole("region", { name: "Editor: Bass 1 (copy) on Bass" });
  await unique.getByRole("button", { name: "C2, measure 3, step 1", exact: true }).click();
  await expect(unique.getByTestId("note")).toHaveCount(3);

  await page.getByRole("button", { name: /^Select Drums track/ }).click();
  await page.getByRole("group", { name: "Track 1: Drums" }).getByTestId("clip-lane").dblclick({ position: { x: 10, y: 20 } });
  const drumsEditor = page.getByRole("region", { name: "Editor: Drums 1 on Drums" });
  await drumsEditor.getByRole("button", { name: "Kick, measure 1, step 1", exact: true }).click();
  await expect(drumsEditor.getByTestId("note")).toHaveCount(1);

  await page.getByRole("button", { name: "Solo Bass" }).click();
  await page.getByRole("slider", { name: "Volume Bass" }).fill("-6");
  const pan = page.getByRole("slider", { name: "Pan Bass" });
  await pan.focus();
  await page.keyboard.press("Home");
  await expect(pan).toHaveAttribute("aria-valuetext", "100% left");
  await page.getByRole("button", { name: "Mute Bass" }).focus();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Rename song E2E Song" })).toBeVisible();
  const reloaded = page.getByRole("group", { name: /^Track 3: Bass/ });
  await reloaded.getByRole("button", { name: "Bass 1, measures 1 to 4, linked, 2 clips" }).click();
  await expect(page.getByRole("region", { name: "Editor: Bass 1 on Bass" }).getByTestId("note")).toHaveCount(2);
  await reloaded.getByRole("button", { name: "Bass 1 (copy), measures 9 to 12" }).click();
  await expect(page.getByRole("region", { name: "Editor: Bass 1 (copy) on Bass" }).getByTestId("note")).toHaveCount(3);
  await page.getByRole("button", { name: /^Select Drums track/ }).click();
  await expect(page.getByRole("region", { name: "Editor: Drums 1 on Drums" }).getByTestId("note")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Solo Bass" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Volume Bass" })).toHaveValue("-6");
  await expect(page.getByRole("slider", { name: "Pan Bass" })).toHaveAttribute("aria-valuetext", "100% left");
  await expect(page.getByRole("group", { name: /^Track 1: Drums.*not audible/ })).toBeVisible();

  // Only transport state is asserted; audio output is not observable here.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  expect(problems).toEqual([]);
});

test("draw and toggle a song loop region, keep it across a reload, and play once when looping is off", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await page.getByRole("button", { name: "Songs" }).click();
  await page.getByRole("dialog", { name: "Songs" }).getByRole("button", { name: "New song…" }).click();
  const create = page.getByRole("dialog", { name: "New song" });
  await create.getByRole("textbox", { name: "Name" }).fill("Loop Song");
  await create.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("button", { name: "Rename song Loop Song" })).toBeVisible();

  // Four measures keep the play-once run short.
  const length = page.getByRole("spinbutton", { name: "Length" });
  await length.fill("4");
  await length.press("Enter");

  const region = page.getByTestId("loop-region");
  const toggle = page.getByRole("button", { name: "Loop playback" });
  await expect(region).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // With no region the toggle loops the whole song and must not draw one.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(region).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  const box = (await page.getByTestId("loop-hit-layer").boundingBox())!;
  const w = box.width / 4;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1.5 * w, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 2.5 * w, y, { steps: 6 });
  await page.mouse.up();
  await expect(region).toHaveAttribute("data-start", "2");
  await expect(region).toHaveAttribute("data-end", "3");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await region.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(region).toHaveAttribute("data-enabled", "true");
  await toggle.click();
  await expect(region).toHaveAttribute("data-enabled", "false");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Rename song Loop Song" })).toBeVisible();
  await expect(region).toHaveAttribute("data-start", "2");
  await expect(region).toHaveAttribute("data-end", "3");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // Looping off plays measures 1-4 once, about eight seconds, and must stop without pressing Stop.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible({ timeout: 30_000 });

  expect(problems).toEqual([]);
});
