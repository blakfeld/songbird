import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "./securityHeaders";

describe("security headers", () => {
  it("sets the four headers", () => {
    const headers = Object.fromEntries(securityHeaders(false).map((h) => [h.key, h.value]));
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("same-origin");
    expect(headers["Content-Security-Policy"]).toBe(contentSecurityPolicy(false));
  });

  it("allows unsafe-eval only in development", () => {
    expect(contentSecurityPolicy(true)).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(contentSecurityPolicy(false)).not.toContain("unsafe-eval");
  });

  it("blocks framing, plugins and foreign connections", () => {
    const csp = contentSecurityPolicy(false);
    for (const directive of [
      "default-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp.split("; ")).toContain(directive);
    }
  });
});
