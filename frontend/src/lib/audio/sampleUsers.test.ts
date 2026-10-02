import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { setCurrentUserId } from "@/lib/auth/currentUser";
import { signOutLocally } from "@/lib/auth/signOut";
import { addToLibrary, listLibrary } from "./sampleLibrary";
import { listStoredSampleIds, putSample } from "./sampleStore";

vi.mock("@/lib/auth/navigation", () => ({ navigateTo: vi.fn() }));

// jsdom's Blob is not structured-cloneable by fake-indexeddb, unlike the real one in a browser.
beforeAll(() => {
  vi.stubGlobal("Blob", NodeBlob);
});

const entry = (id: string) => ({ id, name: id, sampleRate: 48000, channels: 1, length: 3, importedAt: 1 });
const pcm = { sampleRate: 48000, channels: 1, data: new Float32Array([0.5, 0.25, -0.5]) };

describe("sample storage per user", () => {
  it("hides one user's samples from another, keeps them across sign-out, and returns them on sign-in", async () => {
    setCurrentUserId("alice");
    const { id } = await putSample(pcm, async (sampleId) => void (await addToLibrary(entry(sampleId))));
    expect(await listStoredSampleIds()).toEqual([id]);

    setCurrentUserId("bob");
    expect(await listStoredSampleIds()).toEqual([]);
    expect(await listLibrary()).toEqual([]);

    await signOutLocally();
    setCurrentUserId("alice");
    expect(await listStoredSampleIds()).toEqual([id]);
    expect((await listLibrary()).map((e) => e.id)).toEqual([id]);
  });
});
