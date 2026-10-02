"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { StoredLyricSuggestion } from "@/generated/StoredLyricSuggestion";
import type { Section } from "@/lib/song/types";

export interface ApplyReport {
  message: string;
  failed: boolean;
}

// The section's current name wins, so a rename after the reply is reflected on the button.
function actionLabel(s: StoredLyricSuggestion, sections: readonly Section[]): { text: string; aria?: string } {
  if (s.action === "insert") return { text: "Insert at cursor" };
  if (s.action === "replace_selection") return { text: "Replace selection" };
  const name = sections.find((x) => x.id === s.section_id)?.name ?? s.section_name;
  return name
    ? { text: `Replace [${name.trim()}]`, aria: `Replace the ${name.trim()} section lyrics` }
    : { text: "Replace section" };
}

export function SuggestionCard({
  suggestion,
  sections,
  onApply,
}: {
  suggestion: StoredLyricSuggestion;
  sections: readonly Section[];
  onApply: (suggestion: StoredLyricSuggestion) => ApplyReport;
}) {
  // Session-only: after a reload the outcome of an earlier click is no longer known, so none is claimed.
  const [report, setReport] = useState<ApplyReport | null>(null);
  const label = actionLabel(suggestion, sections);

  return (
    <div className="mt-2 w-full rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
        {suggestion.label}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{suggestion.text}</p>
      {/* Focus stays on the button so a repeated application or the next Tab stop is where the user left it. */}
      <Button className="mt-2 !py-1" aria-label={label.aria} onClick={() => setReport(onApply(suggestion))}>
        {label.text}
      </Button>
      <p
        role="status"
        className={`mt-1.5 text-xs ${
          report?.failed
            ? "font-semibold text-red-700 dark:text-red-400"
            : "text-zinc-600 dark:text-zinc-400"
        }`}
      >
        {report?.message}
      </p>
    </div>
  );
}
