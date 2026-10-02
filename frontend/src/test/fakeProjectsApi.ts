import { ApiError } from "@/lib/api";
import type { ProjectsApi } from "@/lib/song/projectsApi";

interface Stored {
  revision: number;
  updated_at: number;
  song: unknown;
}

// An in-memory stand-in for the projects endpoints, so component tests exercise the real library.
// Unlike the real server it keeps the id a test gives a song on create, because the tests seed and
// then look songs up by the ids of their fixtures; `assignIds` switches to the real server's behaviour.
export function createFakeProjectsApi(options: { assignIds?: boolean } = {}) {
  const projects = new Map<string, Stored>();
  const control = { failReads: false, failWrites: false, refuseCreate: null as string | null, conflictOnSave: false };
  let nextId = 1;

  const read = () => {
    if (control.failReads) throw new ApiError("network_error", "offline", 0);
  };
  const write = () => {
    if (control.failWrites) throw new ApiError("network_error", "offline", 0);
  };
  const find = (id: string) => {
    const found = projects.get(id);
    if (!found) throw new ApiError("not_found", "That resource was not found.", 404);
    return found;
  };

  const api: ProjectsApi = {
    async list() {
      read();
      return [...projects.entries()]
        .map(([id, p]) => {
          const song = p.song as { name: string; time_signature: never; tracks?: unknown[] };
          return {
            id,
            name: song.name,
            time_signature: song.time_signature,
            track_count: song.tracks?.length ?? 0,
            revision: p.revision,
            updated_at: p.updated_at,
          };
        })
        .sort((a, b) => b.updated_at - a.updated_at);
    },
    async create(song) {
      write();
      if (control.refuseCreate) throw new ApiError("invalid_song", control.refuseCreate, 422);
      // The real server ignores the client's id; the default keeps it only so tests can seed by fixture id.
      const id = options.assignIds ? `server-${nextId++}` : song.id;
      const stored = { revision: 1, updated_at: Date.now(), song: { ...structuredClone(song), id } };
      projects.set(id, stored);
      return { id, ...stored };
    },
    async get(id) {
      read();
      return { id, ...structuredClone(find(id)) };
    },
    async save(id, song, revision) {
      write();
      const stored = find(id);
      if (control.conflictOnSave) throw new ApiError("revision_conflict", "stale", 409);
      if (stored.revision !== revision) throw new ApiError("revision_conflict", "stale", 409);
      stored.revision += 1;
      stored.updated_at = Date.now();
      stored.song = structuredClone(song);
      return { revision: stored.revision, updated_at: stored.updated_at };
    },
    async remove(id) {
      write();
      find(id);
      projects.delete(id);
    },
  };

  return {
    api,
    control,
    // Bypasses validation so tests can store a document the client cannot convert.
    seedRaw(id: string, song: unknown) {
      projects.set(id, { revision: 1, updated_at: Date.now(), song });
    },
    stored: (id: string) => projects.get(id),
  };
}
