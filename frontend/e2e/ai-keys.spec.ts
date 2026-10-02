import { expect, test, type Page } from "@playwright/test";
import { HEALTHY_MOCK_KEY, KEYLESS_STORAGE_STATE, runUserCommand } from "./account";

const PASSWORD = "correct-horse-battery";
const OPENAI_KEY = "sk-test-openai-0000000000ok";

const unique = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

// Key saves are throttled per user, and these specs change the user's keys, so each flow gets its
// own account instead of touching the shared one.
async function freshUser(page: Page, label: string) {
  const email = unique(label);
  runUserCommand(["create", email], PASSWORD);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function saveKey(page: Page, provider: "Anthropic" | "OpenAI", action: string, key: string) {
  await page.getByRole("button", { name: `${action} ${provider} key` }).click();
  await page.getByLabel(`${provider} API key`).fill(key);
  await page.getByRole("button", { name: "Save key" }).click();
}

test.describe("without a key", () => {
  test.use({ storageState: KEYLESS_STORAGE_STATE });

  test("AI actions are gated with a link to settings", async ({ page }) => {
    await page.goto("/drum-machine");
    const form = page.getByRole("form", { name: "Generate a pattern" });
    await form.getByRole("textbox", { name: "Describe your groove" }).fill("laid-back boom bap");
    await expect(form.getByRole("button", { name: "Generate" })).toBeDisabled();

    await form.getByRole("link", { name: "Add a key" }).click();
    await expect(page).toHaveURL(/\/settings\/ai-keys\?next=/);
    await expect(page.getByRole("heading", { name: "AI keys", level: 1 })).toBeVisible();
    await expect(page.getByRole("list", { name: "AI providers" }).getByText("Not set")).toHaveCount(2);
  });
});

test.describe("managing keys", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("set, replace, and remove a key", async ({ page }) => {
    await freshUser(page, "keys");
    await page.goto("/settings/ai-keys");
    const providers = page.getByRole("list", { name: "AI providers" });

    await saveKey(page, "Anthropic", "Set", HEALTHY_MOCK_KEY);
    await expect(providers).toContainText("••••00ok");
    await expect(page.getByRole("status").filter({ hasText: "key saved" })).toBeVisible();

    await saveKey(page, "Anthropic", "Replace", "sk-ant-test-1111111111ok");
    await expect(providers).toContainText("••••11ok");
    await expect(providers).not.toContainText("••••00ok");

    await page.getByRole("button", { name: "Remove Anthropic key" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Remove your Anthropic key?" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(providers).toContainText("••••11ok");

    await page.getByRole("button", { name: "Remove Anthropic key" }).click();
    await dialog.getByRole("button", { name: "Remove key" }).click();
    await expect(dialog).toBeHidden();
    await expect(providers.getByText("Not set")).toHaveCount(2);
  });

  test("a rejected key shows an error and saves nothing", async ({ page }) => {
    await freshUser(page, "rejected");
    await page.goto("/settings/ai-keys");

    await saveKey(page, "Anthropic", "Set", "sk-ant-test-000000-rejected");
    await expect(page.getByRole("alert").filter({ hasText: "Anthropic rejected this key" })).toBeVisible();
    await expect(page.getByLabel("Anthropic API key")).toHaveValue("");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("list", { name: "AI providers" }).getByText("Not set")).toHaveCount(2);
  });

  test("a revoked key fails generation with a link back to settings", async ({ page }) => {
    await freshUser(page, "revoked");
    await page.goto("/settings/ai-keys");
    await saveKey(page, "Anthropic", "Set", "sk-ant-test-000000-revoked");
    await expect(page.getByRole("list", { name: "AI providers" })).toContainText("••••oked");

    await page.goto("/drum-machine");
    const form = page.getByRole("form", { name: "Generate a pattern" });
    await form.getByRole("textbox", { name: "Describe your groove" }).fill("laid-back boom bap");
    await form.getByRole("button", { name: "Generate" }).click();

    const alert = page.getByRole("alert").filter({ has: page.getByRole("link", { name: "Replace key" }) });
    await expect(alert).toBeVisible();
    await alert.getByRole("link", { name: "Replace key" }).click();
    await expect(page).toHaveURL(/\/settings\/ai-keys\?next=/);
  });

  test("with both keys, the active provider can be switched", async ({ page }) => {
    await freshUser(page, "switch");
    await page.goto("/settings/ai-keys");
    await saveKey(page, "Anthropic", "Set", HEALTHY_MOCK_KEY);
    await expect(page.getByRole("button", { name: "Replace Anthropic key" })).toBeVisible();
    await saveKey(page, "OpenAI", "Set", OPENAI_KEY);
    await expect(page.getByRole("button", { name: "Replace OpenAI key" })).toBeVisible();

    const group = page.getByRole("group", { name: "Provider for AI features" });
    await expect(group.getByRole("radio", { name: "Anthropic" })).toBeChecked();
    await group.getByRole("radio", { name: "OpenAI" }).check();
    await expect(page.getByRole("status").filter({ hasText: "OpenAI is now used" })).toBeAttached();

    await page.reload();
    await expect(page.getByRole("group", { name: "Provider for AI features" }).getByRole("radio", { name: "OpenAI" })).toBeChecked();
  });
});
