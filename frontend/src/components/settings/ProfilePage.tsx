"use client";

import Link from "next/link";
import { useState } from "react";
import { UsernameForm } from "@/components/account/UsernameForm";
import { AccountMenu } from "@/components/auth/AccountMenu";
import { useAuth } from "@/components/auth/AuthProvider";
import { focusRing, hintClass } from "@/components/ui/classes";

export function ProfilePage() {
  const { user } = useAuth();
  // The auth context holds the user as loaded at page start, so a saved change is tracked here.
  const [username, setUsername] = useState<string | null | undefined>(undefined);
  if (!user) return null;
  const current = username === undefined ? user.username : username;

  return (
    <main className="mx-auto flex w-full max-w-2xl min-w-0 flex-1 flex-col gap-6 bg-zinc-50 px-4 py-6 text-zinc-900 sm:px-6 sm:py-8 dark:bg-black dark:text-zinc-50">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <nav aria-label="Breadcrumb" className="text-sm text-zinc-600 dark:text-zinc-400">
            <Link href="/" className={`rounded-sm underline-offset-2 hover:underline ${focusRing}`}>
              Songbird
            </Link>{" "}
            <span aria-hidden="true">›</span>
          </nav>
          <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>
        </div>
        <AccountMenu />
      </header>

      <section
        aria-label="Account"
        className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-800 dark:bg-zinc-950"
      >
        <dl className="flex flex-col gap-3 text-sm">
          <div>
            <dt className={hintClass}>Email</dt>
            <dd className="break-all font-medium">{user.email}</dd>
          </div>
          <div>
            <dt className={hintClass}>Username</dt>
            <dd className="font-medium">{current ?? "No username set"}</dd>
          </div>
        </dl>
        <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <h2 className="text-base font-semibold">{current ? "Change username" : "Choose a username"}</h2>
          <p className={`mb-3 ${hintClass}`}>
            Your username is shown to song owners next to the comments you leave on their shared songs.
          </p>
          <UsernameForm initial={current ?? ""} onSaved={(saved) => setUsername(saved.username)} />
        </div>
      </section>
    </main>
  );
}
