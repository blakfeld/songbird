// Every browser store that can hold one user's data must be listed here, or signing out leaves it
// readable by the next person on the same browser. A source-scan test fails when one is missing.
export const PER_USER_IDB_DATABASES: readonly string[] = ["songbird-samples"];

// Written before accounts existed, so they belong to no user and are deliberately left alone
// (the "abandon" decision in design D10); listing them here keeps the scan test from flagging them.
export const EXCLUDED_IDB_DATABASES: readonly string[] = ["keyval-store"];

// Cleared wholesale rather than by an allow-list so a future key cannot be forgotten.
export const LOCAL_STORAGE_PREFIX = "songbird.";
