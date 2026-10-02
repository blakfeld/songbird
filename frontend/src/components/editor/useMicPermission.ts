"use client";

import { useInputEnvironment, useWatchInputEnvironment } from "@/components/studio/audio/AudioInputContext";
import type { InputOwner } from "@/lib/audio/recorder/trackInput";

// Record's gate follows this, so the answer to a permission prompt is reflected without a reload.
export function useMicPermission(owner: InputOwner) {
  useWatchInputEnvironment(owner);
  return { permission: useInputEnvironment(owner).permission };
}
