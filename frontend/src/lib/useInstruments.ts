"use client";

import { useMemo } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import { getInstruments } from "./api";
import { withBuiltIns } from "./song/sampler";
import { useApiResource, type ResourceState } from "./useApiResource";

// The server's list never includes the sampler ids, so they are added here once, for everything that looks an instrument up.
export function useInstruments(): ResourceState<InstrumentInfo[]> & { retry: () => void } {
  const { status, data, retry } = useApiResource(getInstruments);
  // Built-ins stand in while the request is out or has failed, because they need nothing from the server and
  // sampler tracks must stay playable and editable without it. The status still reports the request.
  return useMemo(
    () =>
      ({ status, data: withBuiltIns(status === "ready" ? data : []), retry }) as ResourceState<InstrumentInfo[]> & {
        retry: () => void;
      },
    [status, data, retry],
  );
}
