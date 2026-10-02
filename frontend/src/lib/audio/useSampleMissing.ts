"use client";

import { useSampleOverview } from "./useSampleLibrary";

// A sample the song names but this browser never stored plays silently, so the sampler UI says so. The overview
// lookup is the same one audio clips use, which keeps "missing" meaning one thing everywhere.
const ABSENT = "";
export function useSampleMissing(sampleId: string | null): boolean {
  return useSampleOverview(sampleId ?? ABSENT) === "missing" && sampleId !== null;
}
