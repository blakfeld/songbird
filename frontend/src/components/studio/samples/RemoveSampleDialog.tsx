"use client";

import { useEffect, useId, useState } from "react";
import type { SampleLibraryEntry } from "@/lib/audio/sampleLibrary";
import { Button } from "@/components/ui/Button";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { Spinner } from "@/components/ui/Spinner";

// Library removal cannot be undone, so it always asks, and says how many saved songs keep playing the sample.
export function RemoveSampleDialog({
  entry,
  countSongs,
  onCancel,
  onConfirm,
}: {
  entry: SampleLibraryEntry | null;
  countSongs: (sampleId: string) => Promise<number>;
  onCancel: () => void;
  onConfirm: (entry: SampleLibraryEntry) => void;
}) {
  const titleId = useId();
  return (
    <ModalDialog open={entry !== null} onClose={onCancel} role="alertdialog" labelledBy={titleId}>
      {entry && <Body entry={entry} titleId={titleId} countSongs={countSongs} onCancel={onCancel} onConfirm={onConfirm} />}
    </ModalDialog>
  );
}

function Body({
  entry,
  titleId,
  countSongs,
  onCancel,
  onConfirm,
}: {
  entry: SampleLibraryEntry;
  titleId: string;
  countSongs: (sampleId: string) => Promise<number>;
  onCancel: () => void;
  onConfirm: (entry: SampleLibraryEntry) => void;
}) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    countSongs(entry.id).then(
      (n) => !cancelled && setCount(n),
      () => !cancelled && setCount(0),
    );
    return () => {
      cancelled = true;
    };
  }, [countSongs, entry.id]);

  return (
    <div className="flex flex-col gap-3">
      <h2 id={titleId} className="text-base font-semibold">
        Remove {entry.name} from the library?
      </h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300" aria-live="polite">
        {count === null ? (
          <span className="inline-flex items-center gap-2">
            <Spinner />
            Checking songs…
          </span>
        ) : count === 0 ? (
          "It isn't used by any saved song."
        ) : (
          <>
            <strong>
              {count} {count === 1 ? "song" : "songs"}
            </strong>{" "}
            still {count === 1 ? "uses" : "use"} it and will keep playing it.
          </>
        )}
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} autoFocus>
          Cancel
        </Button>
        <Button
          onClick={() => onConfirm(entry)}
          className="!border-red-700 !bg-red-700 !text-white hover:!bg-red-800 dark:!border-red-500 dark:!bg-red-600"
        >
          Remove
        </Button>
      </div>
    </div>
  );
}
