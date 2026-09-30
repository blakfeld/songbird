"use client";

import Link from "next/link";
import { getInstruments } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";

const linkClass =
  "rounded-full bg-black px-6 py-3 font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black dark:bg-white dark:text-black dark:hover:bg-zinc-200 dark:focus-visible:outline-white";

const STUDIO = { href: "/studio", label: "Open the Studio" };

const DRUM_MACHINE = { href: "/drum-machine", label: "Open the Drum Machine" };

export default function Home() {
  const instruments = useApiResource(getInstruments);

  // The drum link doubles as the loading and error state so the page is never empty.
  const links =
    instruments.status === "ready"
      ? instruments.data.map((i) =>
          i.id === "drums"
            ? DRUM_MACHINE
            : { href: `/instruments/${i.id}`, label: `Open the ${i.name}` },
        )
      : [DRUM_MACHINE];

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-zinc-50 px-6 py-24 text-center dark:bg-black">
      <h1 className="text-4xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Songbird
      </h1>
      <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
        Describe a groove and let AI write the pattern.
      </p>
      <nav aria-label="Instruments" className="flex flex-wrap justify-center gap-3">
        {[...links, STUDIO].map((l) => (
          <Link key={l.href} href={l.href} className={linkClass}>
            {l.label}
          </Link>
        ))}
      </nav>
    </main>
  );
}
