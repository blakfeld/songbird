// The frontend cannot know whether the backend runs with `Secure` cookies (the `__Host-` form) or
// over plain http (dev, e2e, docker), so both names count; this must stay in step with the backend.
export const SESSION_COOKIE_NAMES = ["__Host-songbird_session", "songbird_session"] as const;
