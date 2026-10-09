import type { PostedComment } from "./api";

// Outside the `songbird.` prefix on purpose: a listener is not the signed-in account, so signing out of the
// Studio must not wipe what they have written here.
// Written out in full so the storage-registry scan can read the prefix from each literal.
const nameStorageKey = (tokenPrefix: string) => `songbird-listen.${tokenPrefix}.name`;
const commentsStorageKey = (tokenPrefix: string) => `songbird-listen.${tokenPrefix}.comments`;

// Matches the server's token prefix, which is all the owner's list shows of a link.
export const TOKEN_PREFIX_LENGTH = 6;
export const tokenPrefixOf = (token: string) => token.slice(0, TOKEN_PREFIX_LENGTH);

// Bounded so one browser cannot fill storage through a link that accepts 1,000 comments.
const MAX_REMEMBERED = 100;

export function readName(tokenPrefix: string): string {
  try {
    return localStorage.getItem(nameStorageKey(tokenPrefix)) ?? "";
  } catch {
    return "";
  }
}

export function writeName(tokenPrefix: string, name: string): void {
  try {
    localStorage.setItem(nameStorageKey(tokenPrefix), name);
  } catch {
    // Blocked storage only costs the convenience of a remembered name.
  }
}

const isPosted = (value: unknown): value is PostedComment => {
  const c = value as Partial<PostedComment> | null;
  return (
    typeof c === "object" &&
    c !== null &&
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    typeof c.body === "string" &&
    typeof c.at_step === "number" &&
    typeof c.created_at === "number"
  );
};

export function readOwnComments(tokenPrefix: string): PostedComment[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(commentsStorageKey(tokenPrefix)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isPosted) : [];
  } catch {
    return [];
  }
}

export function rememberComment(tokenPrefix: string, comment: PostedComment): PostedComment[] {
  const next = [...readOwnComments(tokenPrefix), comment].slice(-MAX_REMEMBERED);
  try {
    localStorage.setItem(commentsStorageKey(tokenPrefix), JSON.stringify(next));
  } catch {
    // The comment is already posted; it just will not be listed after a reload.
  }
  return next;
}
