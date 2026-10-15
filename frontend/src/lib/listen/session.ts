// What the listen page knows about the visitor. It stays local to the page because the page reads no per-user
// storage, so it never touches the app-wide current user.
export type ListenSession =
  | { status: "checking" }
  | { status: "signedOut" }
  | { status: "signedIn"; username: string | null };

export const loginHref = (token: string) => `/login?next=${encodeURIComponent(`/listen/${token}`)}`;
