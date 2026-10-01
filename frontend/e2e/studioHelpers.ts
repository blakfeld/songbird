import { expect, type Page } from "@playwright/test";

// New songs have no tracks, so each flow adds the instruments it needs.
export async function addTrack(page: Page, instrument: string) {
  await page.getByRole("button", { name: "Add track" }).click();
  await page.getByRole("menuitem", { name: instrument, exact: true }).click();
  await expect(page.getByRole("group", { name: new RegExp(`^Track \\d+: ${instrument}`) }).last()).toBeVisible();
}
