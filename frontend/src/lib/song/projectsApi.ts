import type { TimeSignature } from "@/generated/TimeSignature";
import { postJson, request } from "@/lib/api";
import type { Song } from "./types";

export interface ProjectSummary {
  id: string;
  name: string;
  time_signature: TimeSignature;
  track_count: number;
  revision: number;
  updated_at: number;
}

export interface Project {
  id: string;
  revision: number;
  updated_at: number;
  // Untyped because the server returns the document exactly as stored, including fields this
  // client does not know; `migrateSong` is what turns it into a `Song`.
  song: unknown;
}

export interface SavedProject {
  revision: number;
  updated_at: number;
}

export interface ProjectsApi {
  list(): Promise<ProjectSummary[]>;
  create(song: Song): Promise<Project>;
  get(id: string): Promise<Project>;
  save(id: string, song: Song, revision: number): Promise<SavedProject>;
  remove(id: string): Promise<void>;
}

const url = (id: string) => `/api/v1/projects/${encodeURIComponent(id)}`;

export const projectsApi: ProjectsApi = {
  async list() {
    const body = (await (await request("/api/v1/projects")).json()) as { projects: ProjectSummary[] };
    return body.projects;
  },
  async create(song) {
    const body = (await (await postJson("/api/v1/projects", { song })).json()) as { project: Project };
    return body.project;
  },
  async get(id) {
    const body = (await (await request(url(id))).json()) as { project: Project };
    return body.project;
  },
  async save(id, song, revision) {
    const res = await request(url(id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ song, revision }),
    });
    return (await res.json()) as SavedProject;
  },
  async remove(id) {
    await request(url(id), { method: "DELETE" });
  },
};
