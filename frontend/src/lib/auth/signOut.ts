import { navigateTo } from "./navigation";
import { LOCAL_STORAGE_PREFIX, PER_USER_IDB_DATABASES } from "./perUserStores";

// A blocked delete (another tab holds the database open) never settles, and sign-out must not hang on it.
const IDB_DELETE_WAIT_MS = 1000;

function clearLocalStorage() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LOCAL_STORAGE_PREFIX)) keys.push(key);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    // Blocked storage holds nothing to leak.
  }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      const done = () => resolve();
      req.onsuccess = done;
      req.onerror = done;
      // The browser finishes a blocked delete once the page unloads, so waiting longer gains nothing.
      req.onblocked = done;
      setTimeout(done, IDB_DELETE_WAIT_MS);
    } catch {
      resolve();
    }
  });
}

let signingOut = false;

// The unload warning for unsaved changes must not block a sign-out the user chose or the server forced,
// or an expired session would leave them stuck behind a "leave site?" prompt.
export const isSigningOut = () => signingOut;

export async function signOutLocally(): Promise<void> {
  signingOut = true;
  clearLocalStorage();
  await Promise.all(PER_USER_IDB_DATABASES.map(deleteDatabase));
  const { pathname, search, hash } = window.location;
  // Already on the login page, navigating again would reload it, and any 401 there would loop.
  if (pathname === "/login") {
    signingOut = false;
    return;
  }
  // A full navigation, not a router push, so in-memory stores and undo history go with the page.
  navigateTo(`/login?next=${encodeURIComponent(pathname + search + hash)}`);
}
