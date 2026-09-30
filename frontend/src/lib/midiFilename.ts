import type { Pattern } from "@/generated/Pattern";

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "pattern";

// Mirrors the server's Content-Disposition name so a proxy that strips the header still yields the same file name.
export const midiFilename = (p: Pick<Pattern, "name" | "tempo_bpm">) =>
  `songbird-${slug(p.name)}-${p.tempo_bpm}bpm.mid`;
