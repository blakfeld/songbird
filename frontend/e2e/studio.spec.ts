import { expect, test, type Page } from "@playwright/test";

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

  // A second piano track, renamed, covers duplicate-instrument naming and the rename flow in one step.
  await page.getByRole("button", { name: "Add track" }).click();
  await page.getByRole("menuitem", { name: "Piano", exact: true }).click();
  await expect(page.getByRole("group", { name: "Track 3: Piano 2" })).toBeVisible();
  await page.getByRole("button", { name: "Select Piano 2 track (Piano)" }).last().dblclick();
  await page.getByRole("textbox", { name: "Track name Piano 2" }).fill("Bass");
  await page.keyboard.press("Enter");
  const bass = page.getByRole("group", { name: "Track 3: Bass" });
  await expect(bass).toBeVisible();

  // New clips are one measure, so stretching to four gives the loop room for notes in measure 2 and beyond.
  await bass.getByTestId("clip-lane").dblclick({ position: { x: 10, y: 20 } });
  const growing = bass.getByRole("button", { name: /^Bass 1, measure/ });
  await expect(growing).toBeVisible();
  await growing.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
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

  // A four-measure drum clip makes the song four measures long, which keeps the play-once run short.
  const drumLane = page.getByRole("group", { name: "Track 1: Drums" }).getByTestId("clip-lane");
  await drumLane.dblclick({ position: { x: 10, y: 20 } });
  await page.getByRole("button", { name: /^Drums 1, measure/ }).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(page.getByRole("button", { name: "Drums 1, measures 1 to 4", exact: true })).toBeVisible();

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
  // The ruler spans the 16-measure minimum timeline, not just the song.
  const w = box.width / 16;
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

async function newSong(page: Page, name: string) {
  await page.goto("/studio");
  await page.getByRole("button", { name: "Songs" }).click();
  await page.getByRole("dialog", { name: "Songs" }).getByRole("button", { name: "New song…" }).click();
  const create = page.getByRole("dialog", { name: "New song" });
  await create.getByRole("textbox", { name: "Name" }).fill(name);
  await create.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("button", { name: `Rename song ${name}` })).toBeVisible();
}

test("edit a song's length, meter and key, then select, move, copy and undo notes in the dock", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await newSong(page, "Edit Song");

  // The song has no clips yet, so a clip in measure 6 proves the timeline extends past the song's end.
  const pianoTrack = page.getByRole("group", { name: /^Track 2: Piano/ });
  await page.getByRole("button", { name: /^Select Piano track/ }).click();
  const lane = pianoTrack.getByTestId("clip-lane");
  const laneBox = (await lane.boundingBox())!;
  await lane.dblclick({ position: { x: (laneBox.width / 16) * 5.5, y: 20 } });
  const clip = pianoTrack.getByRole("button", { name: /^Piano 1, measure 6/ });
  await expect(clip).toBeVisible();
  await clip.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(pianoTrack.getByRole("button", { name: "Piano 1, measures 6 to 9", exact: true })).toBeVisible();

  const editor = page.getByRole("region", { name: "Editor: Piano 1 on Piano" });
  const rowCells = (name: string) => editor.getByRole("button", { name: new RegExp(`^${name}, measure \\d+, step \\d+$`) });
  await expect(rowCells("C4")).toHaveCount(4 * 16);
  await expect(editor.getByRole("button", { name: "C4, measure 4, step 16", exact: true })).toBeAttached();
  await expect(editor.getByRole("button", { name: "C4, measure 5, step 1", exact: true })).toHaveCount(0);

  // A 3/4 measure drops the last quarter note, so a note there forces the confirmation path.
  await editor.getByRole("button", { name: "C4, measure 1, step 16", exact: true }).click();
  await expect(editor.getByTestId("note")).toHaveCount(1);
  const timeSignature = page.getByRole("combobox", { name: "Time signature" });
  await timeSignature.selectOption("3/4");
  const confirm = page.getByRole("alertdialog", { name: "Change to 3/4?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(timeSignature).toHaveValue("4/4");
  await expect(editor.getByTestId("note")).toHaveCount(1);

  await timeSignature.selectOption("3/4");
  await page.getByRole("alertdialog", { name: "Change to 3/4?" }).getByRole("button", { name: "Change to 3/4" }).click();
  await expect(timeSignature).toHaveValue("3/4");
  await expect(editor.getByTestId("note")).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "C4, measure 1, step 13", exact: true })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "C4, measure 1, step 12", exact: true })).toBeAttached();

  // Key highlight rides on the piano key descriptions, which keeps the key names stable.
  await page.getByRole("combobox", { name: "Key tonic" }).selectOption("D");
  await page.getByRole("combobox", { name: "Key mode" }).selectOption("minor");
  const key = (name: string) => editor.getByRole("button", { name, exact: true }).first();
  await expect(key("D4")).toHaveAccessibleDescription(/^Tonic of D/);
  await expect(key("F4")).toHaveAccessibleDescription(/^In D/);
  await expect(key("A4")).toHaveAccessibleDescription(/^In D/);
  await expect(key("E4")).toHaveAccessibleDescription(/^In D/);
  await expect(key("B4")).not.toHaveAccessibleDescription(/Tonic of|In D/);
  await expect(key("F#4")).not.toHaveAccessibleDescription(/Tonic of|In D/);

  // Notes sit apart from the grid's left edge so the box can start on an empty cell.
  for (const [row, step] of [["D4", 5], ["F4", 5], ["A4", 9]] as const) {
    await editor.getByRole("button", { name: `${row}, measure 1, step ${step}`, exact: true }).click();
  }
  const notes = editor.getByTestId("note");
  await expect(notes).toHaveCount(3);
  const stepsOf = () => notes.evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.step)).sort((a, b) => a - b));
  const rowsOf = () => notes.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.row).sort());
  const startRows = await rowsOf();
  expect(await stepsOf()).toEqual([4, 4, 8]);

  // Raw mouse coordinates miss anything below the fold or under the dock's sticky toolbar, so centre the notes.
  await notes.nth(1).evaluate((el) => el.scrollIntoView({ block: "center" }));
  const boxes = await notes.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, right: r.right, bottom: r.bottom };
    }),
  );
  const left = Math.min(...boxes.map((b) => b.x)) - 10;
  const top = Math.min(...boxes.map((b) => b.y)) - 3;
  const right = Math.max(...boxes.map((b) => b.right)) + 4;
  const bottom = Math.max(...boxes.map((b) => b.bottom)) + 3;
  // The box starts below the notes and is dragged up, because the grid's sticky ruler covers the top edge.
  await page.mouse.move(right, bottom);
  await page.mouse.down();
  await page.mouse.move(left, top, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText("3 notes selected").first()).toBeVisible();
  await expect(editor.locator('[data-testid="note"][data-selected="true"]')).toHaveCount(3);

  // Dragging one selected note carries the whole block by the same offset.
  const handle = (await notes.first().boundingBox())!;
  const hx = handle.x + handle.width / 2;
  const hy = handle.y + handle.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  // Notes default to four steps, so two cells is the bar's width over two.
  await page.mouse.move(hx + 2 * ((handle.width + 4) / 4), hy, { steps: 8 });
  await page.mouse.up();
  await expect.poll(stepsOf).toEqual([6, 6, 10]);
  expect(await rowsOf()).toEqual(startRows);

  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(notes).toHaveCount(6);

  await page.keyboard.press("Control+z");
  await expect(notes).toHaveCount(3);
  await expect.poll(stepsOf).toEqual([6, 6, 10]);
  await page.keyboard.press("Control+z");
  await expect.poll(stepsOf).toEqual([4, 4, 8]);

  expect(problems).toEqual([]);
});
