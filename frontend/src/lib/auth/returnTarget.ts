// The URL parser, not a prefix check, decides: browsers treat `\` as `/` and drop tabs and newlines,
// so `/\evil.example` and a literal-tab `//` pass a "starts with / but not //" test and still leave the site.
export function safeReturnTarget(next: string | null, origin: string): string {
  if (!next) return "/";
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return "/";
  }
  // `javascript:` and `data:` URLs have an opaque origin, so they fail this check too.
  if (url.origin !== origin) return "/";
  // Returning to the login page would just bounce a signed-in user back and forth.
  if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return "/";
  const target = url.pathname + url.search + url.hash;
  // Dot segments and encoded dots can normalise to a path that starts with `//`, which
  // `location.assign` would read as a protocol-relative URL to another host.
  if (/^[/\\]{2}/.test(target)) return "/";
  return target;
}
