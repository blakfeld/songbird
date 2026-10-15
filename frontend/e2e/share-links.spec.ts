import { expect, test } from "./fixtures";
import { type Browser, type Page } from "@playwright/test";
import { runUserCommand } from "./account";
import { addTrack, newSong } from "./studioHelpers";

const PASSWORD = "correct-horse-battery";
const unique = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Each flow makes its own accounts, so a username claimed in one never collides with another and the shared e2e user stays untouched.
function createUser(label: string, username?: string) {
  const email = `${unique(label)}@example.com`;
  runUserCommand(username ? ["create", email, "--username", username] : ["create", email], PASSWORD);
  return email;
}

async function signedOutContext(browser: Browser) {
  return browser.newContext({ storageState: { cookies: [], origins: [] } });
}

async function signIn(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

// A live link serves the last saved version, and the autosave is debounced, so a listener
// would otherwise race it and see the song as it was before the last edit.
async function savedProject(page: Page, name: string, tracks: number) {
  await expect
    .poll(async () => {
      const { projects } = (await (await page.request.get("/api/v1/projects")).json()) as { projects: { id: string; name: string }[] };
      const saved = projects.find((p) => p.name === name);
      if (!saved) return -1;
      const { project } = (await (await page.request.get(`/api/v1/projects/${saved.id}`)).json()) as { project: { song: { tracks: unknown[] } } };
      return project.song.tracks.length;
    })
    .toBe(tracks);
}

async function createLink(page: Page, options: { remix?: boolean } = {}) {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const share = page.getByRole("dialog");
  if (options.remix) await share.getByRole("form", { name: "Create a link" }).getByRole("switch", { name: "Allow remixing" }).click();
  await share.getByRole("button", { name: "Create link" }).click();
  const url = await share.getByRole("region", { name: "New link" }).getByRole("textbox", { name: "Link" }).inputValue();
  expect(new URL(url).pathname).toMatch(/^\/listen\/.+/);
  await share.getByRole("button", { name: "Close share dialog" }).click();
  return url;
}

test("share a song, a signed-in listener picks a username and comments, the owner resolves it, then revokes the link", async ({
  page,
  browser,
}) => {
  const commenter = createUser("commenter");
  await page.goto("/");
  await newSong(page, "Shared Song");
  await addTrack(page, "Drums");

  await savedProject(page, "Shared Song", 1);
  const url = await createLink(page);

  // A context with no stored state carries no session cookie, like a real listener.
  const listener = await signedOutContext(browser);
  const listen = await listener.newPage();
  await listen.goto(url);
  await expect(listen.getByRole("heading", { name: "Shared Song" })).toBeVisible();
  await listen.getByRole("button", { name: "Play" }).click();
  await expect(listen.getByRole("button", { name: "Stop" })).toBeVisible();
  await listen.getByRole("button", { name: "Stop" }).click();

  // Anonymous listeners can listen but not comment: the form is replaced by a sign-in link.
  await expect(listen.getByRole("link", { name: "Sign in to comment" })).toBeVisible();
  await expect(listen.getByRole("textbox", { name: "Comment" })).toBeHidden();

  await listen.getByRole("link", { name: "Sign in to comment" }).click();
  await expect(listen).toHaveURL(/\/login\?next=%2Flisten%2F/);
  await signIn(listen, commenter);
  await expect(listen).toHaveURL(url);
  // No username yet, so the page points to the Profile page instead of showing the form.
  await expect(listen.getByRole("textbox", { name: "Comment" })).toBeHidden();
  await listen.getByRole("link", { name: "Set a username in your profile" }).click();
  await expect(listen).toHaveURL(/\/settings\/profile$/);
  await listen.getByRole("textbox", { name: "Username" }).fill("Pat");
  await listen.getByRole("button", { name: "Save username" }).click();
  await expect(listen.getByText("Username saved.")).toBeVisible();
  await listen.goto(url);
  await expect(listen.getByText("Commenting as pat")).toBeVisible();
  await listen.getByRole("textbox", { name: "Comment" }).fill("Love the groove");
  await listen.getByRole("button", { name: "Post comment" }).click();
  await expect(listen.getByText("Comment posted.")).toBeVisible();

  // Comments are fetched when the project opens, so a reload picks up the listener's.
  await page.reload();
  const marker = page.getByRole("button", { name: /^Comment from pat/ });
  await expect(marker).toBeVisible();
  await marker.click();
  await expect(page.getByText("Love the groove")).toBeVisible();
  await page.getByRole("button", { name: "Resolve comment from pat" }).click();
  await expect(marker).toBeHidden();

  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(page.getByRole("dialog").getByText(/Revoked/)).toBeVisible();

  await listen.reload();
  await expect(listen.getByRole("heading", { name: "This link isn't available" })).toBeVisible();
  await listener.close();
});

test("remix: sign in from the listen page, remix into the Studio, edit it, and the owner's song stays as it was", async ({
  page,
  browser,
}) => {
  const remixer = createUser("remixer", "remixer");
  await page.goto("/");
  await newSong(page, "Late Train");
  await addTrack(page, "Drums");
  await savedProject(page, "Late Train", 1);
  const url = await createLink(page, { remix: true });
  const owned = async () => {
    const { projects } = (await (await page.request.get("/api/v1/projects")).json()) as {
      projects: { id: string; name: string; revision: number }[];
    };
    return projects.find((p) => p.name === "Late Train")!;
  };
  const before = await owned();

  const ctx = await signedOutContext(browser);
  const listen = await ctx.newPage();
  await listen.goto(url);
  await expect(listen.getByRole("heading", { name: "Late Train" })).toBeVisible();
  await expect(listen.getByRole("button", { name: "Remix" })).toBeHidden();
  await listen.getByRole("link", { name: "Sign in to remix" }).click();
  await signIn(listen, remixer);
  // Signing in only returns here; the visitor still has to choose Remix.
  await expect(listen).toHaveURL(url);
  await listen.getByRole("button", { name: "Remix" }).click();

  await expect(listen).toHaveURL(/\/\?song=/);
  await expect(listen.getByRole("button", { name: "Rename song Late Train (remix)" })).toBeVisible();
  await addTrack(listen, "Drums");
  await expect
    .poll(async () => {
      const { projects } = (await (await listen.request.get("/api/v1/projects")).json()) as {
        projects: { name: string; revision: number }[];
      };
      return projects.find((p) => p.name === "Late Train (remix)")?.revision ?? 0;
    })
    .toBeGreaterThan(1);

  const after = await owned();
  expect(after.revision).toBe(before.revision);

  // Turning remixing off removes the control for the next visitor.
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const row = page.getByRole("dialog").getByRole("group", { name: /^Link \S+…$/ });
  await row.getByRole("switch", { name: "Allow remixing" }).click();
  await expect(row).toContainText("Remixing off");
  await page.getByRole("dialog").getByRole("button", { name: "Close share dialog" }).click();

  const visitor = await ctx.newPage();
  await visitor.goto(url);
  await expect(visitor.getByRole("heading", { name: "Late Train" })).toBeVisible();
  await expect(visitor.getByRole("button", { name: "Remix" })).toBeHidden();
  await expect(visitor.getByRole("link", { name: "Sign in to remix" })).toBeHidden();
  await ctx.close();
});

// The owner works at the default size; only the listener is on a phone.
test("the listen page does not scroll sideways at phone width, signed out or signed in", async ({ page, browser }) => {
  const viewer = createUser("phone", "phoneviewer");
  await page.goto("/");
  await newSong(page, "Phone Song");
  await addTrack(page, "Drums");
  await savedProject(page, "Phone Song", 1);
  const url = await createLink(page, { remix: true });

  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 375, height: 800 } });
  const listen = await ctx.newPage();
  const noOverflow = () =>
    listen.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  await listen.goto(url);
  await expect(listen.getByRole("link", { name: "Sign in to remix" })).toBeVisible();
  await expect(listen.getByRole("link", { name: "Sign in to comment" })).toBeVisible();
  expect(await noOverflow()).toBe(true);

  await listen.getByRole("link", { name: "Sign in to remix" }).click();
  await signIn(listen, viewer);
  await expect(listen.getByRole("button", { name: "Remix" })).toBeVisible();
  await expect(listen.getByText("Commenting as phoneviewer")).toBeVisible();
  expect(await noOverflow()).toBe(true);
  await ctx.close();
});
