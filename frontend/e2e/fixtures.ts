import { test as base, expect } from "@playwright/test";

// All specs share one signed-in user, and songs now live on the server, so without this a spec
// would see the songs earlier specs left behind (the browser used to be fresh for each test).
export const test = base.extend<{ cleanLibrary: void }>({
  cleanLibrary: [
    async ({ request }, use) => {
      const list = await request.get("/api/v1/projects");
      expect(list.ok()).toBe(true);
      const { projects } = (await list.json()) as { projects: { id: string }[] };
      for (const p of projects) await request.delete(`/api/v1/projects/${p.id}`);
      await use();
    },
    { auto: true },
  ],
});

export { expect };
