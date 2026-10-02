import { postJson, request, type RequestOptions } from "@/lib/api";

export interface AuthUser {
  id: string;
  email: string;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const body = (await (await postJson("/api/v1/auth/login", { email, password })).json()) as { user: AuthUser };
  return body.user;
}

export async function logout(): Promise<void> {
  await request("/api/v1/auth/logout", { method: "POST" });
}

export async function me(options?: RequestOptions): Promise<AuthUser> {
  const body = (await (await request("/api/v1/auth/me", undefined, options)).json()) as { user: AuthUser };
  return body.user;
}
