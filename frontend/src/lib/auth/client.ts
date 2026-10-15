import { postJson, putJson, request, type RequestOptions } from "@/lib/api";

export interface AuthUser {
  id: string;
  email: string;
  // Null until the user picks one; commenting on shared songs requires it.
  username: string | null;
}

// The login response carries no username (only `me` does), so the type says so rather than promising a field that would be undefined.
export async function login(email: string, password: string): Promise<Omit<AuthUser, "username">> {
  const body = (await (await postJson("/api/v1/auth/login", { email, password })).json()) as { user: Omit<AuthUser, "username"> };
  return body.user;
}

export async function logout(): Promise<void> {
  await request("/api/v1/auth/logout", { method: "POST" });
}

export async function me(options?: RequestOptions): Promise<AuthUser> {
  const body = (await (await request("/api/v1/auth/me", undefined, options)).json()) as { user: AuthUser };
  return body.user;
}

export async function setUsername(username: string, options?: RequestOptions): Promise<AuthUser> {
  const body = (await (await putJson("/api/v1/account/username", { username }, options)).json()) as { user: AuthUser };
  return body.user;
}
