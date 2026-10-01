import { readFileSync } from "node:fs";
import { Midi } from "@tonejs/midi";
import { expect, test } from "@playwright/test";
import { addTrack, newSong } from "./studioHelpers";

test("build a song across tracks, mix it, reload and find it unchanged", async ({ page }) => {
  // Hydration mismatches surface only as console errors, so any error fails the run.
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();

  await newSong(page, "E2E Song");

  await addTrack(page, "Drums");
  await addTrack(page, "Piano");
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
  await newSong(page, "Loop Song");

  await addTrack(page, "Drums");
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

test("edit a song's length, meter and key, then select, move, copy and undo notes in the dock", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await newSong(page, "Edit Song");
  await addTrack(page, "Drums");
  await addTrack(page, "Piano");

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

test("generate the bass for measures 1 to 4 from the drums, then undo", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await newSong(page, "Generate Song");

  await addTrack(page, "Drums");
  await addTrack(page, "Piano");
  await addTrack(page, "Bass");
  const bass = page.getByRole("group", { name: /^Track 3: Bass/ });
  await expect(bass).toBeVisible();

  await page.getByRole("button", { name: /^Select Drums track/ }).click();
  const drumsTrack = page.getByRole("group", { name: "Track 1: Drums" });
  await drumsTrack.getByTestId("clip-lane").dblclick({ position: { x: 10, y: 20 } });
  const drumClip = drumsTrack.getByRole("button", { name: /^Drums 1, measure 1/ });
  await drumClip.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(drumsTrack.getByRole("button", { name: "Drums 1, measures 1 to 4", exact: true })).toBeVisible();
  const drumsEditor = page.getByRole("region", { name: "Editor: Drums 1 on Drums" });
  await drumsEditor.getByRole("button", { name: "Kick, measure 1, step 1", exact: true }).click();
  await drumsEditor.getByRole("button", { name: "Kick, measure 2, step 1", exact: true }).click();
  await expect(drumsEditor.getByTestId("note")).toHaveCount(2);

  await expect(bass.getByRole("button", { name: /^Bass 1/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Track options for Bass" }).click();
  await page.getByRole("menuitem", { name: /Generate part with AI/ }).click();
  const dialog = page.getByRole("dialog", { name: "Generate Bass" });
  await expect(dialog.getByRole("textbox", { name: "Describe the part" })).toBeFocused();
  await dialog.getByRole("textbox", { name: "Describe the part" }).fill("a bass line that follows the kick");
  await dialog.getByRole("radio", { name: "Custom measures" }).check();
  await dialog.getByRole("spinbutton", { name: "From measure" }).fill("1");
  await dialog.getByRole("spinbutton", { name: "To measure" }).fill("4");
  await dialog.getByRole("button", { name: "Generate" }).click();

  const generated = bass.getByRole("button", { name: "Bass 1, measures 1 to 4", exact: true });
  await expect(generated).toBeVisible();
  await expect(bass.locator("[data-clip-id]")).toHaveCount(1);
  // The clip's notes are drawn inside it, so a note in the bass lane that is not in this clip would be a stray part.
  await expect(bass.getByTestId("clip-notes")).toHaveCount(1);
  await expect(generated.getByTestId("clip-notes")).toBeVisible();
  const bassEditor = page.getByRole("region", { name: "Editor: Bass 1 on Bass" });
  expect(await bassEditor.getByTestId("note").count()).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(bass.locator("[data-clip-id]")).toHaveCount(0);

  expect(problems).toEqual([]);
});

test("build piano, drums and bass through the chat, then undo the bass", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await newSong(page, "Chat Song");
  const input = page.getByRole("textbox", { name: "Message the assistant" });
  const send = async (text: string, reply: string) => {
    await input.fill(text);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("log", { name: "Conversation" }).getByText(reply)).toBeVisible();
    await expect(input).toBeEnabled();
  };

  await send("give me a piano that plays slow jazzy chords", "Added a Piano track.");
  await send("give me the drums to match", "Added a Drums track.");
  await send("now the bass", "Added a Bass track.");

  const tracks = page.getByRole("group", { name: /^Track \d+:/ });
  await expect(tracks).toHaveCount(3);
  await expect(tracks.nth(0)).toHaveAccessibleName(/Piano/);
  await expect(tracks.nth(1)).toHaveAccessibleName(/Drums/);
  await expect(tracks.nth(2)).toHaveAccessibleName(/Bass/);
  for (let i = 0; i < 3; i++) {
    await expect(tracks.nth(i).locator("[data-clip-id]")).toHaveCount(1);
    await expect(tracks.nth(i).getByTestId("clip-notes")).toHaveCount(1);
  }

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(tracks).toHaveCount(2);
  await expect(page.getByRole("group", { name: /^Track \d+: Bass/ })).toHaveCount(0);
  await expect(page.getByText("Track removed")).toBeVisible();

  expect(problems).toEqual([]);
});

test("a named length in the chat grows a new song to that many measures", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await newSong(page, "Length Song");
  await page.getByRole("textbox", { name: "Message the assistant" }).fill("16 bars of slow jazzy piano");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("log", { name: "Conversation" }).getByText("Added a Piano track.")).toBeVisible();

  const added = page.getByRole("group", { name: /^Track 1: Piano/ });
  await expect(added.getByRole("button", { name: /measures 1 to 16/ })).toBeVisible();
  await expect(added.locator("[data-clip-id]")).toHaveCount(1);
  await expect(added.getByTestId("clip-notes")).toHaveCount(1);

  expect(problems).toEqual([]);
});

test("download a project, open it as a new song, and export a multitrack MIDI file", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();
  await page.getByRole("button", { name: "Rename song Untitled song" }).click();
  await page.getByRole("textbox", { name: "Song name" }).fill("Late Train");
  await page.keyboard.press("Enter");

  await addTrack(page, "Drums");
  await addTrack(page, "Piano");
  const drums = page.getByRole("group", { name: "Track 1: Drums" });
  await drums.getByTestId("clip-lane").dblclick({ position: { x: 10, y: 20 } });
  const drumsEditor = page.getByRole("region", { name: "Editor: Drums 1 on Drums" });
  await drumsEditor.getByRole("button", { name: "Kick, measure 1, step 1", exact: true }).click();

  // The piano loop is two measures long and placed twice, so the same note must appear in both clips.
  const piano = page.getByRole("group", { name: "Track 2: Piano" });
  await piano.getByTestId("clip-lane").dblclick({ position: { x: 10, y: 20 } });
  const clip = piano.getByRole("button", { name: /^Piano 1, measure/ });
  await clip.focus();
  await page.keyboard.press("Shift+ArrowRight");
  const first = piano.getByRole("button", { name: "Piano 1, measures 1 to 2" });
  await expect(first).toBeVisible();
  const pianoEditor = page.getByRole("region", { name: "Editor: Piano 1 on Piano" });
  await pianoEditor.getByRole("button", { name: "C4, measure 1, step 1", exact: true }).click();
  await expect(pianoEditor.getByTestId("note")).toHaveCount(1);
  await first.focus();
  await page.keyboard.press("Control+d");
  await expect(piano.getByRole("button", { name: /^Piano 1, measures 3 to 4/ })).toBeVisible();

  const projectDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project" }).click();
  const project = await projectDownload;
  expect(project.suggestedFilename()).toBe("late-train.songbird.json");
  const projectPath = test.info().outputPath("late-train.songbird.json");
  await project.saveAs(projectPath);

  // Opening the file this same browser already holds exercises the id-collision path.
  await page.getByLabel("Project file").setInputFiles(projectPath);
  await expect(page.getByRole("status").filter({ hasText: "as a new song" })).toBeVisible();
  await page.getByRole("button", { name: "Songs" }).click();
  await expect(page.getByRole("dialog", { name: "Songs" }).getByRole("listitem")).toHaveCount(2);
  await page.getByRole("dialog", { name: "Songs" }).getByRole("button", { name: "Close" }).click();
  await expect(piano.getByRole("button", { name: /^Piano 1, measures 3 to 4/ })).toBeVisible();

  const midiDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download MIDI" }).click();
  const midiFile = await midiDownload;
  expect(midiFile.suggestedFilename()).toBe("songbird-late-train-120bpm.mid");
  const midiPath = test.info().outputPath("late-train.mid");
  await midiFile.saveAs(midiPath);

  const midi = new Midi(readFileSync(midiPath));
  // The parser folds the conductor track into the header, so only the song's own tracks are listed.
  expect(midi.header.tempos[0].bpm).toBeCloseTo(120);
  expect(midi.tracks).toHaveLength(2);
  const [drumTrack, pianoTrack] = midi.tracks;
  expect(drumTrack.channel).toBe(9);
  expect(pianoTrack.channel).toBe(0);
  expect(drumTrack.notes.map((n) => n.ticks)).toEqual([0]);
  expect(pianoTrack.notes.map((n) => [n.ticks, n.midi])).toEqual([
    [0, 60],
    [3840, 60],
  ]);

  expect(problems).toEqual([]);
});

test("close the piano roll, reopen it by double-clicking a clip, and find it closed after a reload", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await newSong(page, "Dock Song");
  await addTrack(page, "Piano");
  const track = page.getByRole("group", { name: "Track 1: Piano" });
  await track.getByTestId("clip-lane").dblclick({ position: { x: 10, y: 20 } });
  const clip = track.getByRole("button", { name: /^Piano 1, measure/ });
  const dock = page.getByRole("region", { name: "Editor: Piano 1 on Piano" });
  await expect(dock).toBeVisible();
  const handle = page.getByRole("separator", { name: "Resize piano roll" });
  await expect(handle).toBeVisible();

  await page.getByRole("button", { name: "Close piano roll" }).click();
  await expect(dock).toHaveCount(0);
  await expect(handle).toHaveCount(0);
  await expect(clip).toHaveAttribute("aria-current", "true");

  await clip.click();
  await expect(dock).toHaveCount(0);
  await clip.dblclick();
  await expect(dock).toBeVisible();

  await page.getByRole("button", { name: "Close piano roll" }).click();
  await expect(dock).toHaveCount(0);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Rename song Dock Song" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Editor/ })).toHaveCount(0);

  await page.getByRole("button", { name: /^Piano 1, measure/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Editor: Piano 1 on Piano" })).toBeVisible();

  expect(problems).toEqual([]);
});

test("a sent chat message shows at once and the input stays typeable while the reply is pending", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  // The mock replies instantly, so the request is held to make the pending state observable.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/songs/chat", async (route) => {
    await gate;
    await route.continue();
  });

  await page.goto("/studio");
  await newSong(page, "Pending Song");
  const input = page.getByRole("textbox", { name: "Message the assistant" });
  const send = page.getByRole("button", { name: "Send message" });
  const log = page.getByRole("log", { name: "Conversation" });

  await input.fill("give me a bass line");
  await send.click();
  await expect(log.getByText("give me a bass line")).toBeVisible();
  await expect(page.getByText("Thinking…")).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();
  await expect(input).toBeFocused();
  await input.pressSequentially("next idea");
  await expect(input).toHaveValue("next idea");
  await expect(send).toBeDisabled();
  await input.press("Enter");
  await expect(input).toHaveValue("next idea");

  release();
  await expect(log.getByText("Added a Bass track.")).toBeVisible();
  await expect(page.getByText("Thinking…")).toHaveCount(0);
  await expect(input).toHaveValue("next idea");

  expect(problems).toEqual([]);
});

test("shape a track's sound with the keyboard, undo it, and find it after a reload and in the project file", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await newSong(page, "Sound Song");
  await addTrack(page, "Piano");
  const openPanel = async () => {
    await page.getByRole("button", { name: /^Sound for Piano/ }).click();
    const panel = page.getByRole("dialog", { name: "Piano sound" });
    // Keys sent before the panel takes focus would land on the page behind it.
    await expect(panel).toBeFocused();
    return panel;
  };

  const panel = await openPanel();
  const delay = panel.getByRole("switch", { name: "Delay" });
  await delay.click();
  await expect(delay).toHaveAttribute("aria-checked", "true");

  const mix = panel.getByRole("slider", { name: "Delay Mix" });
  await mix.focus();
  await page.keyboard.press("ArrowUp");
  await expect(mix).toHaveAttribute("aria-valuetext", "31%");
  await page.keyboard.press("Control+z");
  await expect(mix).toHaveAttribute("aria-valuetext", "30%");
  await expect(delay).toHaveAttribute("aria-checked", "true");

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(mix).toHaveAttribute("aria-valuetext", "32%");
  await page.getByRole("button", { name: "Close sound panel" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project" }).click();
  const path = test.info().outputPath("sound-song.songbird.json");
  await (await download).saveAs(path);
  const project = JSON.parse(readFileSync(path, "utf8"));
  const piano = project.song.tracks.find((t: { name: string }) => t.name === "Piano");
  expect(piano.sound).toEqual({ effects: { delay: { enabled: true, mix: 0.32 } } });

  await page.reload();
  await expect(page.getByRole("button", { name: "Rename song Sound Song" })).toBeVisible();
  const reopened = await openPanel();
  await expect(reopened.getByRole("switch", { name: "Delay" })).toHaveAttribute("aria-checked", "true");
  await expect(reopened.getByRole("slider", { name: "Delay Mix" })).toHaveAttribute("aria-valuetext", "32%");


  expect(problems).toEqual([]);
});

test("drag the third track above the second, then undo it", async ({ page }) => {
  await page.goto("/studio");
  await newSong(page, "Order Song");
  await addTrack(page, "Drums");
  await addTrack(page, "Piano");
  await addTrack(page, "Bass");

  const order = () =>
    page.getByRole("group", { name: /^Track \d+:/ }).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  const original = ["Track 1: Drums", "Track 2: Piano", "Track 3: Bass"];
  await expect.poll(order).toEqual(original);

  const grip = (await page.getByRole("button", { name: "Reorder Bass" }).boundingBox())!;
  const piano = (await page.getByRole("group", { name: "Track 2: Piano" }).boundingBox())!;
  const x = grip.x + grip.width / 2;
  await page.mouse.move(x, grip.y + grip.height / 2);
  await page.mouse.down();
  // The lane's top quarter is above its midpoint, so the drop lands before Piano.
  await page.mouse.move(x, piano.y + piano.height / 4, { steps: 8 });
  await page.mouse.up();

  await expect.poll(order).toEqual(["Track 1: Drums", "Track 2: Bass", "Track 3: Piano"]);

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(order).toEqual(original);
});
