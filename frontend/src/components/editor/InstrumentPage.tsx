"use client";

import Link from "next/link";
import { getInstruments } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { ErrorAlert } from "./ErrorAlert";
import { PatternEditorPage } from "./PatternEditorPage";

const panel =
  "mx-auto flex w-full max-w-screen-2xl flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 px-6 py-24 text-center text-zinc-900 dark:bg-black dark:text-zinc-50";

const linkClass =
  "rounded-full bg-black px-6 py-3 font-medium text-white hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black dark:bg-white dark:text-black dark:hover:bg-zinc-200 dark:focus-visible:outline-white";

export function InstrumentPage({ id }: { id: string }) {
  const instruments = useApiResource(getInstruments);

  if (instruments.status === "loading") {
    return (
      <main className={panel}>
        <p role="status">Loading instrument…</p>
      </main>
    );
  }

  if (instruments.status === "error") {
    return (
      <main className={panel}>
        <h1 className="text-3xl font-semibold tracking-tight">Couldn&apos;t load instruments</h1>
        <ErrorAlert message="Instruments could not be loaded." onRetry={instruments.retry} />
        <Link href="/" className={linkClass}>
          Back to Songbird
        </Link>
      </main>
    );
  }

  const instrument = instruments.data?.find((i) => i.id === id);
  if (!instrument) {
    return (
      <main className={panel}>
        <h1 className="text-3xl font-semibold tracking-tight">Instrument not found</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          There is no instrument called &quot;{id}&quot;.
        </p>
        <Link href="/" className={linkClass}>
          Back to Songbird
        </Link>
      </main>
    );
  }

  return <PatternEditorPage instrumentId={id} title={instrument.name} instrument={instrument} />;
}
