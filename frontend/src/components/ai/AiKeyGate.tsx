"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import { focusRing } from "@/components/ui/classes";
import { settingsHref } from "@/lib/aiKeys/keyError";
import { useAiKeys } from "./AiKeysProvider";

function AiKeyNotice({ id }: { id: string }) {
  return (
    <p id={id} className="text-sm text-zinc-700 dark:text-zinc-300">
      Add an Anthropic or OpenAI key to use AI features.{" "}
      <Link href={settingsHref()} className={`rounded-sm font-medium underline underline-offset-2 ${focusRing}`}>
        Add a key
      </Link>
    </p>
  );
}

interface Gate {
  blocked: boolean;
  noticeId: string | undefined;
  notice: ReactNode;
}

// A hook rather than a wrapper because every caller folds `blocked` into a submit guard computed before its JSX.
// It fails open while the summary is loading or unavailable, so users who do have keys never see a flash of
// "add a key"; the server's api_key_required stays the backstop.
export function useAiKeyGate(): Gate {
  const { keysRequired, activeProvider } = useAiKeys();
  const id = useId();
  const blocked = keysRequired && activeProvider === null;
  return {
    blocked,
    noticeId: blocked ? id : undefined,
    notice: blocked ? <AiKeyNotice id={id} /> : null,
  };
}
