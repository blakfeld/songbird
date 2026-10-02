"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { Spinner } from "@/components/ui/Spinner";
import { focusRing, hintClass } from "@/components/ui/classes";
import { Menu, menuItemClass } from "@/components/studio/Menu";
import { logout } from "@/lib/auth/client";
import { signOutLocally } from "@/lib/auth/signOut";
import { getSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { useAuth } from "./AuthProvider";

export function AccountMenu({ library }: { library?: SongLibrary }) {
  const { user } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const titleId = useId();
  // A second click while the first is still flushing must not start a second logout.
  const busy = useRef(false);

  if (!user) return <span aria-hidden="true" className="inline-block size-8 rounded-full bg-zinc-200 dark:bg-zinc-800" />;

  async function finish() {
    try {
      await logout();
    } catch {
      // The browser is leaving this account either way; a failed request must not strand the user signed in here.
    }
    await signOutLocally();
  }

  async function logOut() {
    if (busy.current) return;
    busy.current = true;
    setLoggingOut(true);
    const songs = library ?? getSongLibrary();
    await songs.flush();
    const { ok, saving, conflict } = songs.status.getState();
    if (!ok || saving || conflict) {
      busy.current = false;
      setLoggingOut(false);
      setUnsaved(true);
      return;
    }
    await finish();
  }

  async function logOutAnyway() {
    setUnsaved(false);
    busy.current = true;
    setLoggingOut(true);
    await finish();
  }

  return (
    <>
      <Menu
        label="Account"
        triggerLabel={`Account: ${user.email}`}
        align="right"
        panelClassName="w-64 max-w-[calc(100vw-2rem)]"
        triggerClassName={`inline-flex h-8 max-w-[14rem] items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-900 hover:bg-zinc-100 max-sm:px-2 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900 ${focusRing}`}
        trigger={
          <>
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs dark:bg-zinc-800"
            >
              {user.email.charAt(0).toUpperCase()}
            </span>
            <span className="truncate max-sm:hidden">{user.email}</span>
          </>
        }
      >
        {() => (
          <>
            <div className="px-3 py-2">
              <p className={hintClass}>Signed in as</p>
              <p className="truncate text-sm font-medium" title={user.email}>
                {user.email}
              </p>
            </div>
            <div role="separator" className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
            <button
              type="button"
              role="menuitem"
              aria-disabled={loggingOut}
              className={menuItemClass}
              onClick={() => {
                if (loggingOut) return;
                void logOut();
              }}
            >
              {loggingOut && <Spinner />}
              {loggingOut ? "Logging out…" : "Log out"}
            </button>
          </>
        )}
      </Menu>
      <ModalDialog open={unsaved} onClose={() => setUnsaved(false)} role="alertdialog" labelledBy={titleId}>
        <div className="flex flex-col gap-4">
          <h2 id={titleId} className="text-lg font-semibold">
            Your latest changes aren&apos;t saved
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            If you log out now, changes since the last save will be lost.
          </p>
          <div className="flex justify-end gap-2">
            <Button autoFocus onClick={() => setUnsaved(false)}>
              Stay signed in
            </Button>
            <Button
              className="!border-transparent !bg-red-600 !text-white hover:!bg-red-700"
              onClick={() => void logOutAnyway()}
            >
              Log out anyway
            </Button>
          </div>
        </div>
      </ModalDialog>
    </>
  );
}
