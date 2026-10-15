export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

// The server lowercases before storing and compares without regard to case, so what the user typed is normalised
// here rather than rejected: "Ana" and "ana" are the same claim.
export const normalizeUsername = (raw: string) => raw.trim().toLowerCase();

// Returns the first rule the name breaks, or null. The server stays the authority; this only spares a round trip.
export function checkUsername(raw: string): string | null {
  const name = normalizeUsername(raw);
  if (name.length === 0) return null;
  if (!/^[a-z]/.test(name)) return "Start with a letter.";
  if (!/^[a-z0-9_-]+$/.test(name)) return "Use only letters, digits, _ and -.";
  if (name.length < USERNAME_MIN) return `Use at least ${USERNAME_MIN} characters.`;
  if (name.length > USERNAME_MAX) return `Use at most ${USERNAME_MAX} characters.`;
  return null;
}
