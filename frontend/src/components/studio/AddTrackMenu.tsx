"use client";

import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import { Spinner } from "@/components/ui/Spinner";
import { focusRing } from "@/components/ui/classes";
import { BUILT_IN_IDS } from "@/lib/song/sampler";
import { MAX_TRACKS } from "@/lib/song/types";
import type { ResourceState } from "@/lib/useApiResource";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { InstrumentIcon } from "./InstrumentIcon";
import { Menu, menuItemClass } from "./Menu";

export function AddTrackMenu({
  instruments,
  onRetry,
  trackCount,
  onAdd,
  onAddAudio,
  onAddSampler,
}: {
  instruments: ResourceState<InstrumentInfo[]>;
  onRetry: () => void;
  trackCount: number;
  onAdd: (instrument: InstrumentInfo) => void;
  onAddAudio: () => void;
  onAddSampler: (kind: "keys" | "pads") => void;
}) {
  const full = trackCount >= MAX_TRACKS;
  // The samplers share the drums and melodic kinds, so without this they would also be listed under those groups.
  const listed = instruments.data?.filter((i) => !BUILT_IN_IDS.has(i.id)) ?? [];
  const groups = [
    { title: "Drums", items: listed.filter((i) => i.kind === "drums") },
    { title: "Melodic", items: listed.filter((i) => i.kind === "melodic") },
  ];

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Menu
        label="Add track"
        disabled={full}
        triggerClassName={`inline-flex h-8 items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-900 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 max-sm:px-2 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900 ${focusRing}`}
        trigger={
          <>
            <span aria-hidden="true">+</span>
            <span className="max-sm:hidden">Add track</span>
          </>
        }
      >
        {(close) => (
          <>
            {/* Above the loading and error states because adding audio or a sampler never needs the instruments request. */}
            <div role="group" aria-label="Audio">
              <p aria-hidden="true" className="px-3 pt-2 text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                Audio
              </p>
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  close();
                  onAddAudio();
                }}
              >
                <InstrumentIcon instrumentId="audio" kind={null} className="size-6" />
                Audio
              </button>
              {(["keys", "pads"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => {
                    close();
                    onAddSampler(kind);
                  }}
                >
                  <InstrumentIcon instrumentId={`sampler-${kind}`} kind={null} className="size-6" />
                  Sampler ({kind})
                </button>
              ))}
            </div>
            <div role="separator" className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
            {instruments.status === "loading" && (
              <p className="flex items-center gap-2 px-3 py-2 text-sm">
                <Spinner />
                Loading instruments…
              </p>
            )}
            {instruments.status === "error" && (
              <div className="p-2">
                <ErrorAlert message="Couldn't load instruments." onRetry={onRetry} />
              </div>
            )}
            {groups
              .filter((g) => g.items.length > 0)
              .map((g) => (
                <div key={g.title} role="group" aria-label={g.title}>
                  <p aria-hidden="true" className="px-3 pt-2 text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                    {g.title}
                  </p>
                  {g.items.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      role="menuitem"
                      className={menuItemClass}
                      onClick={() => {
                        close();
                        onAdd(i);
                      }}
                    >
                      <InstrumentIcon instrumentId={i.id} kind={i.kind} className="size-6" />
                      {i.name}
                    </button>
                  ))}
                </div>
              ))}
          </>
        )}
      </Menu>
      <span className="text-xs whitespace-nowrap text-zinc-600 tabular-nums dark:text-zinc-400">
        {full ? `${MAX_TRACKS}/${MAX_TRACKS} · limit reached` : `${trackCount}/${MAX_TRACKS}`}
      </span>
    </div>
  );
}
