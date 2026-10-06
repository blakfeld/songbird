import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";
import { newSong } from "./studioHelpers";

test("generate a topline from the Chorus lyrics, keep its syllables through edits, and export them as MIDI lyrics", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await newSong(page, "Topline Song");

  const sections = page.getByRole("group", { name: "Sections" });
  const implicit = sections.getByRole("button", { name: /^Song \(other\), measure/ });
  await implicit.focus();
  await page.keyboard.press("F2");
  let dialog = page.getByRole("dialog", { name: "Edit Song" });
  await dialog.getByRole("combobox", { name: "Kind" }).selectOption({ label: "Verse" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Verse");
  await dialog.getByRole("combobox", { name: "Length" }).selectOption({ label: "4 measures" });
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Add section" }).click();
  dialog = page.getByRole("dialog", { name: "Add section" });
  await dialog.getByRole("combobox", { name: "Kind" }).selectOption({ label: "Chorus" });
  await dialog.getByRole("combobox", { name: "Length" }).selectOption({ label: "4 measures" });
  await dialog.getByRole("button", { name: "Add section" }).click();
  await expect(sections.getByRole("button", { name: "Chorus, measures 5 to 8" })).toBeVisible();

  await page.getByRole("tab", { name: "Lyrics" }).click();
  const notepad = page.getByRole("textbox", { name: "Lyrics" });
  await notepad.click();
  await page.keyboard.type("[Verse]");
  await page.keyboard.press("Enter");
  await page.keyboard.type("one more night");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[Chorus]");
  await page.keyboard.press("Enter");
  await page.keyboard.type("hold me close");
  await page.keyboard.press("Enter");
  await page.keyboard.type("never let go");

  // Tab leaves the text for the buttons on the heading lines, in order, and Enter presses the focused one.
  await notepad.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Generate topline for Verse" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Generate topline for Chorus" })).toBeFocused();
  await page.keyboard.press("Enter");
  dialog = page.getByRole("dialog", { name: "Generate topline" });
  await expect(dialog.getByText(/Chorus, measures 5 to 8/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "hold", pressed: true, exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "Edit split of never" }).click();
  await dialog.getByRole("textbox", { name: "Split never with hyphens" }).fill("ne-ver");
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "ne-", pressed: true, exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "ver", pressed: false, exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "Generate" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: /stressed syllables on the beat/ })).toBeVisible();

  const vocal = page.getByRole("group", { name: /^Track 1: Vocal/ });
  await expect(vocal.getByRole("button", { name: "Chorus topline, measures 5 to 8", exact: true })).toBeVisible();
  const editor = page.getByRole("region", { name: "Editor: Chorus topline on Vocal" });
  await expect(editor.getByTestId("note-lyric").first()).toHaveText("hold");
  await expect(editor.getByTestId("note-lyric")).toHaveText(["hold", "me", "close", "ne-", "ver", "let", "go"]);

  // Moving a note changes its pitch, never its syllable.
  const held = editor.getByTestId("note").filter({ has: page.getByTestId("note-lyric").filter({ hasText: /^hold$/ }) });
  const rowBefore = await held.getAttribute("data-row");
  await editor.getByRole("button", { name: /lyric hold/ }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Alt+ArrowDown");
  await expect(held).not.toHaveAttribute("data-row", rowBefore!);
  await expect(held.getByTestId("note-lyric")).toHaveText("hold");

  // Editing the Chorus lyrics leaves the notes alone but flags the topline as out of date.
  // Clicking the middle of the notepad could land on a heading's button, so focus is set directly.
  await notepad.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" tonight");
  await expect(page.getByText(/Chorus lyrics have changed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate" })).toBeVisible();

  const midi = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download MIDI" }).click();
  const path = test.info().outputPath("topline.mid");
  await (await midi).saveAs(path);
  const bytes = readFileSync(path);
  // A Lyric meta event is FF 05, a length, then the text.
  expect(bytes.includes(Buffer.concat([Buffer.from([0xff, 0x05, 4]), Buffer.from("hold")]))).toBe(true);

  // One step undoes the move and one the generation, and neither touches the lyrics text.
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(vocal).toHaveCount(0);
  await expect(page.locator(".cm-line")).toContainText(["[Verse]", "one more night", "", "[Chorus]", "hold me close", "never let go tonight"]);

  expect(problems).toEqual([]);
});
