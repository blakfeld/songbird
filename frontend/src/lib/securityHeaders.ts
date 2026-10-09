// A baseline CSP with inline scripts allowed rather than a nonce-based one: nonces would force every
// page to render dynamically. It still blocks framing, plugins, foreign scripts and connections,
// and base-tag tricks.
export function contentSecurityPolicy(dev: boolean): string {
  return [
    "default-src 'self'",
    // React Refresh evaluates code in development only.
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function securityHeaders(dev: boolean): { key: string; value: string }[] {
  const headers = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(dev) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "same-origin" },
  ];
  // Dev runs over plain http on localhost, where a pinned HSTS entry would break other local apps.
  // No includeSubDomains or preload: the first deployment is on *.fly.dev, which we don't own.
  if (!dev) headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000" });
  return headers;
}

// A share link is a capability: indexing it would publish what the owner meant to hand to a few people.
export function listenHeaders(): { key: string; value: string }[] {
  return [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];
}
