let userId: string | null = null;

// Per-user storage keys embed this id, so a store built before it is known would write under the
// wrong user; failing loudly beats leaking one user's work into another's keys.
export const setCurrentUserId = (id: string | null) => {
  userId = id;
};

export const getCurrentUserId = () => userId;

export function requireCurrentUserId(): string {
  if (userId === null) throw new Error("No signed-in user: per-user storage was used before sign-in resolved");
  return userId;
}
