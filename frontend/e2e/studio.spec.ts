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

  const editor = page.getByRole("region", { name: "Editor: Bass" });
  await editor.getByRole("button", { name: "C2, measure 1, step 1", exact: true }).click();
  await editor.getByRole("button", { name: "C2, measure 2, step 1", exact: true }).click();
  await expect(editor.getByTestId("note")).toHaveCount(2);
  await expect(bass.getByRole("img")).toHaveAccessibleName(/2 notes/);

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

  await page.getByRole("button", { name: /^Select Drums track/ }).click();
  const drumsEditor = page.getByRole("region", { name: "Editor: Drums" });
  await drumsEditor.getByRole("button", { name: "Kick, measure 1, step 1", exact: true }).click();
  await expect(drumsEditor.getByTestId("note")).toHaveCount(1);
  await expect(page.getByRole("group", { name: "Track 1: Drums" }).getByRole("img")).toHaveAccessibleName(/1 note/);

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
  await expect(reloaded.getByRole("img")).toHaveAccessibleName(/2 notes/);
  await expect(page.getByRole("group", { name: /^Track 1: Drums/ }).getByRole("img")).toHaveAccessibleName(/1 note/);
  await expect(page.getByRole("button", { name: "Solo Bass" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Volume Bass" })).toHaveValue("-6");
  await expect(page.getByRole("slider", { name: "Pan Bass" })).toHaveAttribute("aria-valuetext", "100% left");
  await expect(page.getByRole("group", { name: /^Track 1: Drums.*not audible/ })).toBeVisible();

  // Only transport state is asserted; audio output is not observable here.
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();

  expect(problems).toEqual([]);
});
