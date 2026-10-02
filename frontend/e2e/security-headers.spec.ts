import { expect, test } from "@playwright/test";

// /studio needs the signed-in storage state that the e2e global setup provides; /login is public.
for (const path of ["/login", "/studio"]) {
  test(`${path} is served with the security headers and no CSP violations`, async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => /content security policy/i.test(m.text()) && violations.push(m.text()));

    const response = await page.goto(path);
    const headers = response!.headers();

    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("same-origin");
    const csp = headers["content-security-policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");

    await page.waitForLoadState("networkidle");
    expect(violations).toEqual([]);
  });
}
