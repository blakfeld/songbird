import { postJson, request } from "@/lib/api";

// Hand-written like the project types: these shapes are owned by the share endpoints, not by the song document.
export type ShareMode = "live" | "snapshot";
export type ShareStatus = "active" | "expired" | "revoked";

export interface ShareLink {
  id: string;
  token_prefix: string;
  mode: ShareMode;
  label: string;
  allow_comments: boolean;
  allow_downloads: boolean;
  expires_at: number | null;
  created_at: number;
  revoked_at: number | null;
  status: ShareStatus;
  unresolved_comments: number;
}

export interface NewShare {
  mode: ShareMode;
  expires_at: number | null;
  allow_comments: boolean;
  allow_downloads: boolean;
  label?: string;
}

export interface ShareEdit {
  label: string;
  expires_at: number | null;
  allow_comments: boolean;
  allow_downloads: boolean;
}

export interface CreatedShare {
  share: ShareLink;
  // Returned once; the server keeps only a hash, so it cannot be shown again.
  token: string;
  url: string;
}

export interface OwnerComment {
  id: string;
  share_id: string;
  share_label: string;
  token_prefix: string;
  name: string;
  body: string;
  at_step: number;
  section_id: string | null;
  section_name: string | null;
  project_revision: number | null;
  created_at: number;
  resolved_at: number | null;
}

export interface ShareApi {
  list(projectId: string): Promise<ShareLink[]>;
  create(projectId: string, share: NewShare): Promise<CreatedShare>;
  update(projectId: string, shareId: string, edit: ShareEdit): Promise<ShareLink>;
  revoke(projectId: string, shareId: string): Promise<void>;
  listComments(projectId: string): Promise<OwnerComment[]>;
  setResolved(projectId: string, commentId: string, resolved: boolean): Promise<OwnerComment>;
  removeComment(projectId: string, commentId: string): Promise<void>;
}

const project = (id: string) => `/api/v1/projects/${encodeURIComponent(id)}`;
const shares = (id: string) => `${project(id)}/shares`;
const comments = (id: string) => `${project(id)}/comments`;

function putJson(path: string, body: unknown): Promise<Response> {
  return request(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export const shareApi: ShareApi = {
  async list(projectId) {
    return ((await (await request(shares(projectId))).json()) as { shares: ShareLink[] }).shares;
  },
  async create(projectId, share) {
    return (await (await postJson(shares(projectId), share)).json()) as CreatedShare;
  },
  async update(projectId, shareId, edit) {
    const res = await putJson(`${shares(projectId)}/${encodeURIComponent(shareId)}`, edit);
    return ((await res.json()) as { share: ShareLink }).share;
  },
  async revoke(projectId, shareId) {
    await request(`${shares(projectId)}/${encodeURIComponent(shareId)}`, { method: "DELETE" });
  },
  async listComments(projectId) {
    return ((await (await request(comments(projectId))).json()) as { comments: OwnerComment[] }).comments;
  },
  async setResolved(projectId, commentId, resolved) {
    const res = await putJson(`${comments(projectId)}/${encodeURIComponent(commentId)}`, { resolved });
    return ((await res.json()) as { comment: OwnerComment }).comment;
  },
  async removeComment(projectId, commentId) {
    await request(`${comments(projectId)}/${encodeURIComponent(commentId)}`, { method: "DELETE" });
  },
};
