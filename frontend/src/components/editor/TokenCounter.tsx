export function TokenCounter({ id, count, max }: { id: string; count: number; max: number | null }) {
  const over = max !== null && count > max;
  return (
    <p
      id={id}
      className={`text-xs tabular-nums font-mono ${over ? "font-semibold text-red-700 dark:text-red-400" : "text-zinc-600 dark:text-zinc-400"}`}
    >
      <span>
        {count} / {max ?? "…"}
      </span>{" "}
      tokens
      {over && <span> Too long. Shorten your description.</span>}
    </p>
  );
}
