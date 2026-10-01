import { expect, type Page } from "@playwright/test";

// New songs have no tracks, so each flow adds the instruments it needs.
export async function addTrack(page: Page, instrument: string) {
  await page.getByRole("button", { name: "Add track" }).click();
  await page.getByRole("menuitem", { name: instrument, exact: true }).click();
  await expect(page.getByRole("group", { name: new RegExp(`^Track \\d+: ${instrument}`) }).last()).toBeVisible();
}

// A first visit already creates "Untitled song", so the new one is usually "Untitled song 2".
export async function newSong(page: Page, name: string) {
  // The first-visit song must exist before the list is read, or its name would not count as taken.
  await expect(page.getByRole("button", { name: /^Rename song / })).toBeVisible();
  const header = page.getByRole("button", { name: /^Rename song Untitled song( \d+)?$/ });
  const before = await page.getByRole("button", { name: /^Rename song / }).getAttribute("aria-label");
  await page.getByRole("button", { name: "Songs" }).click();
  const library = page.getByRole("dialog", { name: "Songs" });
  await library.getByRole("button", { name: "New song", exact: true }).click();
  // The old song's header can match the pattern too, so rename only once the header shows the new song.
  await expect(library).toBeHidden();
  await expect(page.getByRole("button", { name: /^Rename song / })).not.toHaveAttribute("aria-label", before!);
  await header.click();
  await page.getByRole("textbox", { name: "Song name" }).fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: `Rename song ${name}` })).toBeVisible();
}
