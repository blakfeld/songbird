import { expect, test, type Page } from "@playwright/test";
import { runUserCommand } from "./account";

// These specs start signed out. Each makes its own users, because the login throttle locks an
// (email, address) pair after repeated failures and must never touch the shared e2e account.
test.use({ storageState: { cookies: [], origins: [] } });

const PASSWORD = "correct-horse-battery";
const unique = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

function createUser(label: string, password = PASSWORD) {
  const email = unique(label);
  runUserCommand(["create", email], password);
  return email;
}

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("visiting the Studio signed out goes to login and returns after signing in", async ({ page }) => {
  const email = createUser("return");
  await page.goto("/studio");
  await expect(page).toHaveURL(/\/login\?next=%2Fstudio$/);
  await signIn(page, email);
  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();
  await expect(page.getByRole("button", { name: `Account: ${email}` })).toBeVisible();
});

test("a wrong password shows the message and keeps the email", async ({ page }) => {
  const email = createUser("wrong");
  await page.goto("/login");
  await signIn(page, email, "not-the-password-1");
  await expect(page.getByRole("alert").filter({ hasText: "Email or password" })).toHaveText("Email or password is incorrect");
  await expect(page.getByLabel("Email")).toHaveValue(email);
  await expect(page).toHaveURL(/\/login$/);
});

test("logging out and pressing Back does not show the user's projects", async ({ page }) => {
  const email = createUser("logout");
  await page.goto("/login?next=/studio");
  await signIn(page, email);
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();

  await page.getByRole("button", { name: `Account: ${email}` }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.goBack();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("region", { name: "Arrangement" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Rename song / })).toHaveCount(0);
});

test("two users do not see each other's songs", async ({ browser }) => {
  const a = createUser("alice");
  const b = createUser("bob");

  const ctxA = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const pageA = await ctxA.newPage();
  await pageA.goto("/login?next=/studio");
  await signIn(pageA, a);
  await expect(pageA.getByRole("button", { name: "Rename song Untitled song" })).toBeVisible();
  await pageA.getByRole("button", { name: "Rename song Untitled song" }).click();
  await pageA.getByRole("textbox", { name: "Song name" }).fill("Alice Only");
  await pageA.keyboard.press("Enter");
  await expect(pageA.getByRole("button", { name: "Rename song Alice Only" })).toBeVisible();
  // Autosave is debounced, so wait for the save to land before another user looks.
  await expect
    .poll(async () => {
      const body = (await (await ctxA.request.get("/api/v1/projects")).json()) as { projects: { name: string }[] };
      return body.projects.map((p) => p.name);
    })
    .toContain("Alice Only");
  await ctxA.close();

  const ctxB = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const pageB = await ctxB.newPage();
  await pageB.goto("/login?next=/studio");
  await signIn(pageB, b);
  await expect(pageB.getByRole("region", { name: "Arrangement" })).toBeVisible();
  await pageB.getByRole("button", { name: "Songs" }).click();
  const library = pageB.getByRole("dialog", { name: "Songs" });
  await expect(library.getByRole("listitem")).toHaveCount(1);
  await expect(library.getByText("Alice Only")).toHaveCount(0);
  await ctxB.close();
});

test("a session ended mid-session sends the user to login, and signing in returns to the Studio", async ({ page }) => {
  const email = createUser("expire");
  await page.goto("/login?next=/studio");
  await signIn(page, email);
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();

  // Setting a password ends every session of the account, as an operator would.
  const next = "another-long-password-1";
  runUserCommand(["set-password", email], next);

  await page.getByRole("button", { name: "Rename song Untitled song" }).click();
  await page.getByRole("textbox", { name: "Song name" }).fill("After expiry");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/login\?next=%2Fstudio/);
  await signIn(page, email, next);
  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();
});

test("a cookie-less /healthz through the frontend is the backend's 200, not a redirect", async ({ request }) => {
  const res = await request.get("/healthz", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});
