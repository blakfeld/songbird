// Every browser store that can hold one user's data must be registered here, or signing out leaves it
// readable by the next person on the same browser. A source-scan test fails when one is missing.

// Deleted on sign-out. Empty today: the only per-user databases are the kept ones below.
export const PER_USER_IDB_DATABASES: readonly string[] = [];

// Database names are these prefixes followed by the user id, and sign-out deliberately keeps them.
// Sample audio exists only in this browser, so clearing it would destroy the user's work, and the id
// in the name keeps another user on this browser from seeing it.
export const KEPT_PER_USER_IDB_PREFIXES: readonly string[] = ["songbird-samples.", "songbird-sample-library."];

// Written before accounts existed, so they belong to no user and are deliberately left alone
// (the "abandon" decision in design D10); listing them here keeps the scan test from flagging them.
export const EXCLUDED_IDB_DATABASES: readonly string[] = [
  "keyval-store",
  "songbird-samples",
  "songbird-sample-library",
];

// Cleared wholesale rather than by an allow-list so a future key cannot be forgotten.
export const LOCAL_STORAGE_PREFIX = "songbird.";

// A listener's remembered name and own comments, keyed by share link. They belong to no account, so sign-out leaves them
// alone, and the registry scan accepts this prefix beside the per-user one.
export const LISTEN_STORAGE_PREFIX = "songbird-listen.";
