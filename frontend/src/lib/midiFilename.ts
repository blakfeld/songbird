import type { Song } from "@/generated/Song";
import type { Pattern } from "@/generated/Pattern";

export const slugify = (name: string, fallback: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;

const slug = (name: string) => slugify(name, "pattern");

// Mirrors the server's Content-Disposition name so a proxy that strips the header still yields the same file name.
export const midiFilename = (p: Pick<Pattern, "name" | "tempo_bpm">) =>
  `songbird-${slug(p.name)}-${p.tempo_bpm}bpm.mid`;

// Songs use the same slug rule so a proxy-stripped header still yields the server's file name.
export const songMidiFilename = (s: Pick<Song, "name" | "tempo_bpm">) =>
  `songbird-${slugify(s.name, "song")}-${s.tempo_bpm}bpm.mid`;
