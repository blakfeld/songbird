import { expect, test } from "./fixtures";
import { addTrack } from "./studioHelpers";

test("build a song from sections, repeat the chorus, delete the intro, and keep the notes after a reload", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();
  await page.getByRole("button", { name: "Rename song Untitled song" }).click();
  await page.getByRole("textbox", { name: "Song name" }).fill("Sectioned");
  await page.keyboard.press("Enter");
  await addTrack(page, "Drums");

  const sections = page.getByRole("group", { name: "Sections" });
  // An untouched song is one implicit section, so the first edit turns it into the Intro.
  const implicit = sections.getByRole("button", { name: /^Song \(other\), measure/ });
  await expect(implicit).toBeVisible();
  // A one-measure block is too narrow for its menu button, so the keyboard shortcut is the way in.
  await implicit.focus();
  await page.keyboard.press("F2");
  let dialog = page.getByRole("dialog", { name: "Edit Song" });
  await dialog.getByRole("combobox", { name: "Kind" }).selectOption({ label: "Intro" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Intro");
  await dialog.getByRole("combobox", { name: "Length" }).selectOption({ label: "4 measures" });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(sections.getByRole("button", { name: "Intro, measures 1 to 4" })).toBeVisible();

  for (const [kind, length] of [["Verse", "8 measures"], ["Chorus", "8 measures"]]) {
    await page.getByRole("button", { name: "Add section" }).click();
    dialog = page.getByRole("dialog", { name: "Add section" });
    await dialog.getByRole("combobox", { name: "Kind" }).selectOption({ label: kind });
    await dialog.getByRole("combobox", { name: "Length" }).selectOption({ label: length });
    await dialog.getByRole("button", { name: "Add section" }).click();
  }
  await expect(sections.getByRole("button", { name: "Verse, measures 5 to 12" })).toBeVisible();
  await expect(sections.getByRole("button", { name: "Chorus, measures 13 to 20" })).toBeVisible();

  // The lane is drawn 28 measures wide here, so the middle of measure 13 is 12.5/28 of the way across.
  const drums = page.getByRole("group", { name: "Track 1: Drums" });
  const lane = drums.getByTestId("clip-lane");
  const box = (await lane.boundingBox())!;
  await lane.dblclick({ position: { x: (box.width * 12.5) / 28, y: 20 } });
  const editor = page.getByRole("region", { name: "Editor: Drums 1 on Drums" });
  await editor.getByRole("button", { name: "Kick, measure 1, step 1", exact: true }).click();
  await expect(editor.getByTestId("note")).toHaveCount(1);
  await expect(drums.getByRole("button", { name: /^Drums 1, measure 13/ })).toBeVisible();

  await page.getByRole("button", { name: "Section actions for Chorus", exact: true }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(sections.getByRole("button", { name: "Chorus 2 (chorus), measures 21 to 28" })).toBeVisible();
  // The copy is a clip of the same loop, so the two are linked.
  await expect(drums.getByRole("button", { name: /^Drums 1, measure 13, linked, 2 clips/ })).toBeVisible();
  await expect(drums.getByRole("button", { name: /^Drums 1, measure 21, linked, 2 clips/ })).toBeVisible();

  await page.getByRole("button", { name: "Section actions for Intro", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete section" }).click();
  await expect(sections.getByRole("button", { name: "Verse, measures 1 to 8" })).toBeVisible();
  await expect(sections.getByRole("button", { name: "Chorus, measures 9 to 16" })).toBeVisible();
  await expect(drums.getByRole("button", { name: /^Drums 1, measure 9, linked/ })).toBeVisible();
  await expect(drums.getByRole("button", { name: /^Drums 1, measure 17, linked/ })).toBeVisible();

  await page.getByRole("button", { name: "Section actions for Chorus", exact: true }).click();
  await page.getByRole("menuitem", { name: "Notes…" }).click();
  const notes = page.getByRole("textbox", { name: "Notes for Chorus" });
  await expect(notes).toBeFocused();
  // The space would start playback if the field let it through.
  await page.keyboard.type("call and response with the guitar");
  await expect(notes).toHaveValue("call and response with the guitar");
  await page.getByRole("tab", { name: "Assistant" }).focus();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.reload();
  await expect(sections.getByRole("button", { name: "Chorus, measures 9 to 16" })).toBeVisible();
  await expect(sections.getByRole("button", { name: "Chorus 2 (chorus), measures 17 to 24" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Section", selected: true })).toBeVisible();
  await page.getByRole("button", { name: "Select Chorus, measures 9 to 16" }).click();
  await expect(page.getByRole("textbox", { name: "Notes for Chorus" })).toHaveValue("call and response with the guitar");
  await expect(page.getByRole("group", { name: "Track 1: Drums" }).getByRole("button", { name: /^Drums 1, measure 9, linked/ })).toBeVisible();

  expect(problems).toEqual([]);
});
