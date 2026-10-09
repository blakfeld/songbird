import { headingName } from "@/lib/lyrics/headings";

// Not the Studio's editor: that one is a CodeMirror instance with editing, chat and section actions, none of which a
// listener may have, and loading it would be paid for only to switch all of that off.
export function ReadOnlyLyrics({ lyrics }: { lyrics: string }) {
  if (lyrics.trim() === "") return null;
  return (
    <section aria-labelledby="listen-lyrics-heading" className="flex flex-col gap-2">
      <h2 id="listen-lyrics-heading" className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
        Lyrics
      </h2>
      <div className="flex flex-col text-sm leading-6">
        {lyrics.split("\n").map((line, i) => {
          const name = headingName(line);
          if (name !== null) {
            return (
              <h3 key={i} className="mt-3 text-sm font-semibold text-zinc-900 first:mt-0 dark:text-zinc-50">
                {name.trim()}
              </h3>
            );
          }
          // A blank line keeps its height so stanza breaks survive.
          return (
            <p key={i} className="min-h-6 whitespace-pre-wrap">
              {line}
            </p>
          );
        })}
      </div>
    </section>
  );
}
