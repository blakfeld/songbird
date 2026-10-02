import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentUserId } from "@/lib/auth/currentUser";
import { note, trackWithNotes } from "@/test/fixtures";
import { resolveTrackNotes } from "./clipOps";
import { createServerSongLibrary, lastSongStorageKey, type SongLibrary } from "./songLibrary";
import { createSongStore } from "./songStore";
import { newSongWithTracks } from "./testFixtures";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const failure = (status: number, code: string, headers: Record<string, string> = {}) =>
  json({ error: { code, message: "server text" } }, status, headers);

interface Call {
  method: string;
  path: string;
  body: { song?: Record<string, unknown>; revision?: number } | undefined;
}

// Mirrors the server contract the library depends on: the server picks ids, revisions must match,
// and a response can be scripted ahead of the real handling to simulate throttling and outages.
function createServer() {
  const projects = new Map<string, { revision: number; song: Record<string, unknown> }>();
  const calls: Call[] = [];
  const scripted: Array<Response | Error> = [];
  let nextId = 1;

  let dropPutResponses = 0;
  const handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const injected = scripted.shift();
    if (injected instanceof Error) throw injected;
    if (injected) return injected;

    const body = calls[calls.length - 1].body;
    const id = path.split("/")[4];
    if (!id) {
      if (method === "POST") {
        const created = `p${nextId++}`;
        projects.set(created, { revision: 1, song: { ...body!.song!, id: created } });
        return json({ project: { id: created, revision: 1, updated_at: 1, song: projects.get(created)!.song } }, 201);
      }
      return json({
        projects: [...projects].map(([pid, p]) => ({
          id: pid,
          name: p.song.name,
          time_signature: p.song.time_signature,
          track_count: (p.song.tracks as unknown[]).length,
          revision: p.revision,
          updated_at: p.revision,
        })),
      });
    }
    const stored = projects.get(id);
    if (!stored) return failure(404, "not_found");
    if (method === "DELETE") {
      projects.delete(id);
      return new Response(null, { status: 204 });
    }
    if (method === "PUT") {
      if (body!.revision !== stored.revision) return failure(409, "revision_conflict");
      stored.revision += 1;
      stored.song = body!.song!;
      return json({ revision: stored.revision, updated_at: stored.revision });
    }
    return json({ project: { id, revision: stored.revision, updated_at: 1, song: stored.song } });
  };
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const response = await handle(input, init);
    // The save committed but the client never hears about it.
    if (init?.method === "PUT" && dropPutResponses > 0) {
      dropPutResponses -= 1;
      throw new TypeError("connection lost");
    }
    return response;
  });
  vi.stubGlobal("fetch", fetchFn);

  return {
    projects,
    calls,
    puts: () => calls.filter((c) => c.method === "PUT"),
    dropNextPutResponses: (n: number) => (dropPutResponses = n),
    script: (...responses: Array<Response | Error>) => scripted.push(...responses),
    seed(song: unknown) {
      const id = `p${nextId++}`;
      projects.set(id, { revision: 1, song: { ...(song as object), id } });
      return id;
    },
  };
}

let server: ReturnType<typeof createServer>;
let lib: SongLibrary;

beforeEach(() => {
  localStorage.clear();
  server = createServer();
  lib = createServerSongLibrary();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// A save within a second of the previous one is held back, so tests that time the debounce start after that.
const createSettled = async (song: Parameters<SongLibrary["create"]>[0]) => {
  const created = await lib.create(song);
  await vi.advanceTimersByTimeAsync(1050);
  return created;
};

// Regions clamp to the timeline derived from the song's clips, so a song with real clips keeps the round trip honest.
const eightMeasureSong = () => {
  const song = newSongWithTracks();
  song.tracks[0] = trackWithNotes(song.tracks[0], [note("kick", 0)], 8);
  song.measures = 8;
  return song;
};

describe("create and open", () => {
  it("adopts the server's id and remembers it as last opened", async () => {
    const song = newSongWithTracks();
    const created = await lib.create(song);
    expect(created.id).toBe("p1");
    expect(created).toEqual({ ...song, id: "p1" });
    expect(lib.getLastSongId()).toBe("p1");
    expect(localStorage.getItem(lastSongStorageKey("test-user"))).toBe("p1");
    expect(server.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/projects" });
  });

  it("remembers the last-opened song per user", async () => {
    setCurrentUserId("a");
    const { id } = await lib.create(newSongWithTracks());
    expect(localStorage.getItem(lastSongStorageKey("a"))).toBe(id);
    setCurrentUserId("b");
    expect(lib.getLastSongId()).toBeNull();
    setCurrentUserId("a");
    expect(lib.getLastSongId()).toBe(id);
  });

  it("restores a saved song", async () => {
    const song = eightMeasureSong();
    song.tracks[0].volume_db = -6;
    const { id } = await lib.create(song);
    expect(await createServerSongLibrary().open(id)).toEqual({ ...song, id });
  });

  it("raises the failure banner and throws when a create fails", async () => {
    server.script(new TypeError("offline"));
    await expect(lib.create(newSongWithTracks())).rejects.toMatchObject({ code: "network_error" });
    expect(lib.status.getState().ok).toBe(false);
  });

  it("peeks and puts without changing the last-opened song", async () => {
    const current = await lib.create(newSongWithTracks());
    const other = await lib.put({ ...newSongWithTracks(), name: "Other" });
    expect(other.id).not.toBe(current.id);
    expect(lib.getLastSongId()).toBe(current.id);
    expect(await lib.peek(other.id)).toEqual(other);
    expect(lib.getLastSongId()).toBe(current.id);
  });

  it("puts a changed known song as a revisioned save", async () => {
    const song = await lib.create(newSongWithTracks());
    await lib.put({ ...song, name: "Changed" });
    expect(server.puts()[0].body).toMatchObject({ revision: 1, song: { name: "Changed" } });
  });

  it("lists projects with their track counts", async () => {
    await lib.create({ ...newSongWithTracks("3/4"), name: "A" });
    expect(await lib.list()).toEqual([{ id: "p1", name: "A", time_signature: "3/4", track_count: 2, updated_at: 1 }]);
  });

  it("reports a missing song as absent and a malformed one as invalid, not as a failed read", async () => {
    const song = newSongWithTracks();
    const bad = server.seed({ ...song, tracks: [{ ...song.tracks[0], loops: [null] }] });
    expect(await lib.open(bad)).toBeNull();
    expect(lib.readStatus.getState()).toMatchObject({ failed: false, invalid: true });
    expect(await lib.open("missing")).toBeNull();
    expect(lib.readStatus.getState()).toMatchObject({ failed: false, invalid: false });
  });

  it("reports read failures separately from save failures", async () => {
    await lib.create(newSongWithTracks());
    server.script(new TypeError("offline"));
    expect(await lib.list()).toEqual([]);
    expect(lib.readStatus.getState().failed).toBe(true);
    expect(lib.status.getState().ok).toBe(true);
  });

  it("converts songs saved before clips without writing them back until an edit", async () => {
    const song = newSongWithTracks();
    const drumsTrack: Record<string, unknown> = { ...song.tracks[0] };
    delete drumsTrack.loops;
    delete drumsTrack.clips;
    const v1 = {
      ...song,
      measures: 8,
      version: 1,
      tracks: [{ ...drumsTrack, notes: [note("kick", 0)], future_flag: 7 }, { ...song.tracks[1], loops: [], clips: [] }],
    };
    const id = server.seed(v1);
    const opened = (await lib.open(id))!;
    expect(opened.version).toBe(2);
    expect(resolveTrackNotes(opened, opened.tracks[0])).toEqual([note("kick", 0)]);
    expect((opened.tracks[0] as unknown as Record<string, unknown>).future_flag).toBe(7);
    await lib.flush();
    expect(server.puts()).toHaveLength(0);
  });
});

describe("saving", () => {
  it("sends the revision with every save and tracks the one the server returns", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    lib.save({ ...song, name: "One" });
    await vi.advanceTimersByTimeAsync(300);
    lib.save({ ...song, name: "Two" });
    await vi.advanceTimersByTimeAsync(1050);
    expect(server.puts().map((p) => p.body!.revision)).toEqual([1, 2]);
    expect(server.projects.get(song.id)!.song.name).toBe("Two");
  });

  it("holds a save back until a second after the previous one instead of provoking a 429", async () => {
    vi.useFakeTimers();
    const song = await lib.create(newSongWithTracks());
    lib.save({ ...song, name: "Quick" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.puts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(server.puts()).toHaveLength(1);
    expect(lib.status.getState().ok).toBe(true);
  });

  it("debounces saves by 300 ms", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    lib.save(song);
    lib.save({ ...song, name: "Later" });
    await vi.advanceTimersByTimeAsync(299);
    expect(server.puts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.puts()).toHaveLength(1);
    expect(server.puts()[0].body!.song!.name).toBe("Later");
  });

  it("autosaves store edits, including a loop region change", async () => {
    const song = await lib.create(eightMeasureSong());
    const store = createSongStore(song);
    lib.autosave(store);
    store.getState().setLoop({ region: { start: 2, end: 3 }, enabled: false });
    await lib.flush();
    const saved = (await lib.open(song.id))!;
    expect(saved.loop_region).toEqual({ region: { start_measure: 2, end_measure: 3 }, enabled: false });
  });

  it("writes unrecognised fields back unchanged", async () => {
    const song = { ...newSongWithTracks(), sections: [{ name: "Verse" }] };
    (song.tracks[0] as unknown as Record<string, unknown>).future_flag = 7;
    const id = server.seed(song);
    const store = createSongStore((await lib.open(id))!);
    lib.autosave(store);
    store.getState().setTempo(100);
    await lib.flush();
    const saved = server.projects.get(id)!.song;
    expect(saved.sections).toEqual([{ name: "Verse" }]);
    expect((saved.tracks as Record<string, unknown>[])[0].future_flag).toBe(7);
    expect(saved.tempo_bpm).toBe(100);
  });

  it("reports saving from an edit until its write lands", async () => {
    const song = await lib.create(newSongWithTracks());
    expect(lib.status.getState().saving).toBe(false);
    lib.save({ ...song, name: "Changed" });
    expect(lib.status.getState().saving).toBe(true);
    await lib.flush();
    expect(lib.status.getState().saving).toBe(false);
  });
});

describe("revision conflict", () => {
  it("sets conflict, stops autosave for that song, and does not report a failure", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    server.projects.get(song.id)!.revision = 5;

    lib.save({ ...song, name: "Mine" });
    await vi.advanceTimersByTimeAsync(300);
    expect(lib.status.getState()).toMatchObject({ conflict: true, ok: true, saving: false });

    lib.save({ ...song, name: "Mine again" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.puts()).toHaveLength(1);
    expect(server.projects.get(song.id)!.revision).toBe(5);
  });

  it("does not stop autosave for other songs", async () => {
    vi.useFakeTimers();
    const a = await createSettled(newSongWithTracks());
    const b = await createSettled(newSongWithTracks());
    server.projects.get(a.id)!.revision = 5;
    lib.save(a);
    await vi.advanceTimersByTimeAsync(300);
    lib.save({ ...b, name: "B edit" });
    await vi.advanceTimersByTimeAsync(300);
    expect(server.projects.get(b.id)!.song.name).toBe("B edit");
  });

  it("resumes after the song is reloaded", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    server.projects.get(song.id)!.revision = 5;
    lib.save(song);
    await vi.advanceTimersByTimeAsync(300);
    expect(lib.status.getState().conflict).toBe(true);

    const reloaded = (await lib.open(song.id))!;
    expect(lib.status.getState().conflict).toBe(false);
    lib.save({ ...reloaded, name: "After reload" });
    await vi.advanceTimersByTimeAsync(300);
    expect(server.puts().at(-1)!.body).toMatchObject({ revision: 5 });
    expect(server.projects.get(song.id)!.revision).toBe(6);
  });

  it("drops a queued edit instead of retrying it once the conflict is known", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    server.projects.get(song.id)!.revision = 5;
    lib.save(song);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.puts()).toHaveLength(1);
  });
});

describe("a retry after a lost response", () => {
  it("adopts the committed revision instead of reporting a conflict", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    server.dropNextPutResponses(1);
    lib.save({ ...song, name: "Committed" });
    await vi.advanceTimersByTimeAsync(300);
    expect(lib.status.getState().ok).toBe(false);

    await vi.advanceTimersByTimeAsync(1100);
    expect(lib.status.getState()).toMatchObject({ ok: true, conflict: false, saving: false });
    expect(server.projects.get(song.id)!.revision).toBe(2);

    // The adopted revision is the real one, so the next edit saves cleanly.
    lib.save({ ...song, name: "Next" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(server.projects.get(song.id)!.song.name).toBe("Next");
    expect(lib.status.getState().conflict).toBe(false);
  });

  it("still reports a conflict when another session changed the song", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    server.script(new TypeError("offline"));
    lib.save({ ...song, name: "Mine" });
    await vi.advanceTimersByTimeAsync(300);
    server.projects.get(song.id)!.revision = 5;
    server.projects.get(song.id)!.song = { ...song, name: "Theirs" };
    await vi.advanceTimersByTimeAsync(1100);
    expect(lib.status.getState().conflict).toBe(true);
  });
});

describe("put", () => {
  it("throws a conflict error and leaves no banner when the song was changed elsewhere", async () => {
    const song = await lib.create(newSongWithTracks());
    server.projects.get(song.id)!.revision = 5;
    await expect(lib.put({ ...song, name: "Mine" })).rejects.toMatchObject({ name: "SaveRefusedError", conflict: true });
    expect(lib.status.getState().conflict).toBe(false);
  });

  it("throws and drops the save when the server keeps throttling it", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    const throttle = () => failure(429, "too_many_requests", { "Retry-After": "1" });
    server.script(throttle(), throttle(), throttle(), throttle());
    const result = lib.put({ ...song, name: "Throttled" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ name: "SaveRefusedError", conflict: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.projects.get(song.id)!.song.name).not.toBe("Throttled");
  });
});

describe("throttled saves", () => {
  it("reschedules after Retry-After without reporting a failure", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    server.script(failure(429, "too_many_requests", { "Retry-After": "2" }));

    lib.save({ ...song, name: "Throttled" });
    await vi.advanceTimersByTimeAsync(300);
    expect(server.puts()).toHaveLength(1);
    expect(lib.status.getState()).toMatchObject({ ok: true, saving: true, conflict: false });

    await vi.advanceTimersByTimeAsync(1999);
    expect(server.puts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.puts()).toHaveLength(2);
    expect(server.projects.get(song.id)!.song.name).toBe("Throttled");
    expect(lib.status.getState()).toMatchObject({ ok: true, saving: false });
  });

  it("keeps the newest edit when one arrives while waiting out a 429", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    server.script(failure(429, "too_many_requests", { "Retry-After": "1" }));
    lib.save({ ...song, name: "Old" });
    await vi.advanceTimersByTimeAsync(300);
    lib.save({ ...song, name: "New" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.projects.get(song.id)!.song.name).toBe("New");
  });

  it("waits out the interval when flushing instead of giving up", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    server.script(failure(429, "too_many_requests", { "Retry-After": "1" }));
    lib.save({ ...song, name: "Flushed" });
    const flushed = lib.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flushed;
    expect(server.projects.get(song.id)!.song.name).toBe("Flushed");
    expect(lib.status.getState().ok).toBe(true);
  });
});

describe("failed saves", () => {
  it("reports a network failure while editing keeps working, then retries with backoff", async () => {
    vi.useFakeTimers();
    const store = createSongStore(await createSettled(newSongWithTracks()));
    lib.autosave(store);
    server.script(new TypeError("offline"), new TypeError("offline"));

    store.getState().renameSong("Still editable");
    await vi.advanceTimersByTimeAsync(300);
    expect(lib.status.getState()).toMatchObject({ ok: false, saving: true });
    expect(lib.status.getState().message).toMatch(/not being saved/i);
    expect(store.getState().song!.name).toBe("Still editable");

    await vi.advanceTimersByTimeAsync(999);
    expect(server.puts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.puts()).toHaveLength(2);
    // The delay doubles after each failure.
    await vi.advanceTimersByTimeAsync(1999);
    expect(server.puts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.puts()).toHaveLength(3);
    expect(lib.status.getState()).toMatchObject({ ok: true, saving: false });
    expect(server.projects.get(store.getState().song!.id)!.song.name).toBe("Still editable");
  });

  it("retries after a server error", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    server.script(failure(503, "server_busy"));
    lib.save({ ...song, name: "Retried" });
    await vi.advanceTimersByTimeAsync(300 + 1000);
    expect(server.projects.get(song.id)!.song.name).toBe("Retried");
  });

  it("shows the reason and does not retry a refusal that cannot succeed", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    server.script(failure(409, "project_limit"));
    lib.save({ ...song, name: "Too big" });
    await vi.advanceTimersByTimeAsync(300);
    expect(lib.status.getState().ok).toBe(false);
    expect(lib.status.getState().message).toMatch(/limit/i);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.puts()).toHaveLength(1);
  });

  it("lets the manual retry save again", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    server.script(failure(422, "invalid_song"));
    lib.save(song);
    await vi.advanceTimersByTimeAsync(300);
    expect(lib.status.getState().ok).toBe(false);
    lib.save(song);
    await vi.advanceTimersByTimeAsync(300);
    expect(lib.status.getState().ok).toBe(true);
  });
});

describe("rename, duplicate and remove", () => {
  it("renames by loading then saving with the loaded revision", async () => {
    const song = await lib.create(newSongWithTracks());
    const renamed = (await lib.rename(song.id, " Renamed "))!;
    expect(renamed.name).toBe("Renamed");
    expect(server.calls.slice(-2).map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect((await lib.open(song.id))!.name).toBe("Renamed");
  });

  it("duplicates independently under a server-assigned id", async () => {
    const demo = { ...eightMeasureSong(), name: "Demo" };
    const { id } = await lib.create(demo);
    const copy = (await lib.duplicate(id))!;
    expect(copy.name).toBe("Demo (copy)");
    expect(copy.id).not.toBe(id);
    expect(copy.tracks).toEqual(demo.tracks);
    expect(server.calls.slice(-2).map((c) => c.method)).toEqual(["GET", "POST"]);

    lib.save({ ...copy, tracks: [{ ...copy.tracks[0], loops: [], clips: [] }, ...copy.tracks.slice(1)] });
    await lib.flush();
    expect((await lib.open(id))!.tracks[0].loops).toHaveLength(1);
    expect((await lib.open(copy.id))!.tracks[0].loops).toHaveLength(0);
    expect(await lib.list()).toHaveLength(2);
  });

  it("copies the loop region", async () => {
    const demo = { ...eightMeasureSong(), loop_region: { region: { start_measure: 3, end_measure: 5 }, enabled: false } };
    const { id } = await lib.create(demo);
    expect((await lib.duplicate(id))!.loop_region).toEqual(demo.loop_region);
  });

  it("deletes the project and the last-opened pointer, and drops a pending save", async () => {
    vi.useFakeTimers();
    const song = await createSettled(newSongWithTracks());
    lib.save({ ...song, name: "Never sent" });
    await lib.remove(song.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.puts()).toHaveLength(0);
    expect(await lib.list()).toEqual([]);
    expect(lib.getLastSongId()).toBeNull();
    expect(lib.status.getState().saving).toBe(false);
  });

  it("treats deleting a song that is already gone as done", async () => {
    await lib.remove("missing");
    expect(lib.status.getState().ok).toBe(true);
  });
});
