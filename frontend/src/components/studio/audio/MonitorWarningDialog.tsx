"use client";

import { useId } from "react";
import { Button } from "@/components/ui/Button";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { hintClass } from "@/components/ui/classes";

export const MONITOR_WARNED_KEY = "songbird.monitorWarned.v1";

// Shown before monitoring starts because speakers feed back the instant the route opens, so a warning after the fact
// would arrive with the howl.
export function MonitorWarningDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  return (
    <ModalDialog open={open} onClose={onCancel} role="alertdialog" labelledBy={titleId}>
      <div className="flex flex-col gap-3">
        <h2 id={titleId} className="text-base font-semibold">
          Wear headphones to monitor
        </h2>
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          Monitor plays your microphone back to you as you sing or play. Through speakers, the microphone can pick that
          sound up again and cause loud feedback. Plug in headphones first, or keep the volume low.
        </p>
        <p className={hintClass}>You won&apos;t be asked again in this browser.</p>
        <div className="flex justify-end gap-2">
          {/* The safer choice is the default, so a stray Enter does not open the route. */}
          <Button autoFocus onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Turn on Monitor
          </Button>
        </div>
      </div>
    </ModalDialog>
  );
}
