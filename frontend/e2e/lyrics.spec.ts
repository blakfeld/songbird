import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";

test("write lyrics in the notepad, reload to find them, and carry them through a project file", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();
  await page.getByRole("button", { name: "Rename song Untitled song" }).click();
  await page.getByRole("textbox", { name: "Song name" }).fill("Words Song");
  await page.keyboard.press("Enter");

  await page.getByRole("tab", { name: "Lyrics" }).click();
  const notepad = page.getByRole("textbox", { name: "Lyrics" });
  await notepad.click();
  // The r and spaces would start a recording or playback if the notepad let them through.
  await page.keyboard.type("[Chorus]");
  await page.keyboard.press("Enter");
  await page.keyboard.type("red roses are rare");
  await page.keyboard.press("Enter");
  await page.keyboard.type("sing it out loud");
  await expect(page.locator(".cm-lyric-heading")).toHaveText("[Chorus]");
  // Leaving the notepad hands the typing to the song at once instead of after the debounce, so "Saved" is not stale.
  await page.getByRole("tab", { name: "Assistant" }).focus();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("tab", { name: "Lyrics", selected: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Lyrics" })).toContainText("sing it out loud");
  await expect(page.locator(".cm-line")).toHaveText(["[Chorus]", "red roses are rare", "sing it out loud"]);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project" }).click();
  const projectPath = test.info().outputPath("words-song.songbird.json");
  await (await download).saveAs(projectPath);
  const file = JSON.parse(readFileSync(projectPath, "utf8")) as { song: { lyrics?: string } };
  expect(file.song.lyrics).toBe("[Chorus]\nred roses are rare\nsing it out loud");

  await page.getByLabel("Project file").setInputFiles(projectPath);
  await expect(page.getByRole("status").filter({ hasText: "as a new song" })).toBeVisible();
  await page.getByRole("button", { name: "Songs" }).click();
  await expect(page.getByRole("dialog", { name: "Songs" }).getByRole("listitem")).toHaveCount(2);
  await page.getByRole("dialog", { name: "Songs" }).getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".cm-line")).toHaveText(["[Chorus]", "red roses are rare", "sing it out loud"]);

  expect(problems).toEqual([]);
});
