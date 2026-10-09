const DAY_MS = 24 * 60 * 60 * 1000;

export type ExpiryChoice = "never" | "1" | "7" | "30";

export const EXPIRY_CHOICES: { id: ExpiryChoice; label: string }[] = [
  { id: "never", label: "Never" },
  { id: "1", label: "1 day" },
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
];

// Counted from the moment the owner submits, because the server refuses a time that has already passed by the time it arrives.
export function expiryFrom(choice: ExpiryChoice, now: number): number | null {
  return choice === "never" ? null : now + Number(choice) * DAY_MS;
}

export function describeExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return "No expiry";
  return `Expires ${new Date(expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}
