import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const watchProblems = (page: Page) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
  return problems;
};

const ask = async (page: Page, message: string) => {
  await page.getByRole("textbox", { name: "Message the lyric assistant" }).fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("log", { name: "Lyric conversation" }).getByText(message, { exact: true })).toBeVisible();
};

// The mock derives its suggestion text from the request, so the test reads the lines from the card.
const cardText = async (page: Page, button: string | RegExp) => {
  const card = page.locator("div.rounded-lg").filter({ has: page.getByRole("button", { name: button }) });
  return (await card.locator("p").nth(1).innerText()).trim().split("\n");
};

test("sections, headings, lyrics, then replace a selection and a section, and find it all after a reload", async ({ page }) => {
  const problems = watchProblems(page);
  await page.goto("/studio");
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();

  for (const kind of ["Verse", "Chorus"]) {
    await page.getByRole("button", { name: "Add section" }).click();
    const dialog = page.getByRole("dialog", { name: "Add section" });
    await dialog.getByRole("combobox", { name: "Kind" }).selectOption({ label: kind });
    await dialog.getByRole("button", { name: "Add section" }).click();
  }

  await page.getByRole("tab", { name: "Lyrics" }).click();
  await page.getByRole("button", { name: "Add section headings" }).click();
  const lines = page.locator(".cm-line");
  await expect(lines).toHaveText(["[Song]", "[Verse]", "[Chorus]"]);
  await expect(page.locator(".cm-lyric-heading-unlinked")).toHaveCount(0);

  const notepad = page.getByRole("textbox", { name: "Lyrics" });
  await notepad.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("first line");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second line");
  await page.keyboard.press("Shift+Home");

  await ask(page, "make the second line rhyme");
  const replaceSelection = page.getByRole("button", { name: "Replace selection" });
  await expect(replaceSelection).toBeVisible();
  const selectionText = await cardText(page, "Replace selection");
  await replaceSelection.click();
  await expect(page.getByText("✓ Replaced.").first()).toBeVisible();
  await expect(lines).toHaveText(["[Song]", "[Verse]", "[Chorus]", "first line", ...selectionText]);

  const replaceSection = page.getByRole("button", { name: "Replace the Song section lyrics" });
  const sectionText = await cardText(page, "Replace the Song section lyrics");
  // Earlier saves hold the old [Song] section, so only one that starts with the replaced section proves the last edit landed.
  const lastEditSaved = page.waitForResponse((r) => {
    if (r.request().method() !== "PUT" || !r.url().includes("/projects/")) return false;
    const lyrics: string = r.request().postDataJSON()?.song?.lyrics ?? "";
    return r.ok() && lyrics.startsWith(["[Song]", ...sectionText, "[Verse]"].join("\n"));
  });
  await replaceSection.click();
  await expect(lines).toHaveText(["[Song]", ...sectionText, "[Verse]", "[Chorus]", "first line", ...selectionText]);

  await lastEditSaved;
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("tab", { name: "Lyrics", selected: true })).toBeVisible();
  await expect(page.locator(".cm-line")).toHaveText(["[Song]", ...sectionText, "[Verse]", "[Chorus]", "first line", ...selectionText]);
  const log = page.getByRole("log", { name: "Lyric conversation" });
  await expect(log.getByText("make the second line rhyme", { exact: true })).toBeVisible();
  await expect(log.getByRole("button", { name: "Replace selection" })).toBeVisible();

  expect(problems).toEqual([]);
});

test("an unsectioned song scaffolds [Song] and a replace_section suggestion fills it", async ({ page }) => {
  const problems = watchProblems(page);
  await page.goto("/studio");
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();
  await page.getByRole("tab", { name: "Lyrics" }).click();

  await page.getByRole("button", { name: "Add section headings" }).click();
  await expect(page.locator(".cm-line")).toHaveText(["[Song]"]);

  await ask(page, "write me an opener");
  const apply = page.getByRole("button", { name: "Replace the Song section lyrics" });
  const text = await cardText(page, "Replace the Song section lyrics");
  await apply.click();
  await expect(page.locator(".cm-line")).toHaveText(["[Song]", ...text]);

  expect(problems).toEqual([]);
});
