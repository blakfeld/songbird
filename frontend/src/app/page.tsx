import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-zinc-50 px-6 py-24 text-center dark:bg-black">
      <h1 className="text-4xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Songbird
      </h1>
      <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
        Describe a groove and let AI write the pattern.
      </p>
      <Link
        href="/drum-machine"
        className="rounded-full bg-black px-6 py-3 font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black dark:bg-white dark:text-black dark:hover:bg-zinc-200 dark:focus-visible:outline-white"
      >
        Open the Drum Machine
      </Link>
    </main>
  );
}
