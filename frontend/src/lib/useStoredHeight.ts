import { useCallback } from "react";
import { useStoredValue } from "./useStoredValue";

const parseHeight = (raw: string) => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export function useStoredHeight(key: string): [number | null, (px: number | null) => void] {
  const [value, set] = useStoredValue<number | null>(key, null, parseHeight);
  const setHeight = useCallback((px: number | null) => set(px === null ? null : Math.round(px)), [set]);
  return [value, setHeight];
}
