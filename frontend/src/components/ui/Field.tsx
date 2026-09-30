import type { ReactNode } from "react";
import { hintClass, labelClass } from "./classes";

export function Field({
  label,
  htmlFor,
  hint,
  hintId,
  className = "",
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  hintId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={htmlFor} className={labelClass}>
        {label}
      </label>
      {children}
      {hint && (
        <p id={hintId} className={hintClass}>
          {hint}
        </p>
      )}
    </div>
  );
}
