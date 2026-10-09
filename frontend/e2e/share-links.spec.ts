import { expect, test } from "./fixtures";
import { addTrack, newSong } from "./studioHelpers";

test("share a song, listen and comment without an account, resolve the comment, then revoke the link", async ({
  page,
  request,
  browser,
}) => {
  await page.goto("/studio");
  await newSong(page, "Shared Song");
  await addTrack(page, "Drums");

  // A live link serves the last saved version, and the autosave is debounced, so the listener
  // would otherwise race it and see the song as it was before the rename.
  await expect
    .poll(async () => {
      const { projects } = (await (await request.get("/api/v1/projects")).json()) as { projects: { id: string; name: string }[] };
      const saved = projects.find((p) => p.name === "Shared Song");
      if (!saved) return 0;
      const { project } = (await (await request.get(`/api/v1/projects/${saved.id}`)).json()) as { project: { song: { tracks: unknown[] } } };
      return project.song.tracks.length;
    })
    .toBe(1);

  await page.getByRole("button", { name: "Share", exact: true }).click();
  const share = page.getByRole("dialog");
  await share.getByRole("button", { name: "Create link" }).click();
  const url = await share.getByRole("region", { name: "New link" }).getByRole("textbox", { name: "Link" }).inputValue();
  expect(new URL(url).pathname).toMatch(/^\/listen\/.+/);
  await share.getByRole("button", { name: "Close share dialog" }).click();

  // A context with no stored state carries no session cookie, like a real listener.
  const listener = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const listen = await listener.newPage();
  await listen.goto(url);
  await expect(listen.getByRole("heading", { name: "Shared Song" })).toBeVisible();
  await listen.getByRole("button", { name: "Play" }).click();
  await expect(listen.getByRole("button", { name: "Stop" })).toBeVisible();
  await listen.getByRole("button", { name: "Stop" }).click();

  await listen.getByRole("textbox", { name: "Your name" }).fill("Pat");
  await listen.getByRole("textbox", { name: "Comment" }).fill("Love the groove");
  await listen.getByRole("button", { name: "Post comment" }).click();
  await expect(listen.getByText("Comment posted.")).toBeVisible();

  // Comments are fetched when the project opens, so a reload picks up the listener's.
  await page.reload();
  const marker = page.getByRole("button", { name: /^Comment from Pat/ });
  await expect(marker).toBeVisible();
  await marker.click();
  await expect(page.getByText("Love the groove")).toBeVisible();
  await page.getByRole("button", { name: "Resolve comment from Pat" }).click();
  await expect(marker).toBeHidden();

  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(page.getByRole("dialog").getByText(/Revoked/)).toBeVisible();

  await listen.reload();
  await expect(listen.getByRole("heading", { name: "This link isn't available" })).toBeVisible();
  await listener.close();
});
