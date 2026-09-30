import type { SelectHTMLAttributes } from "react";
import { inputClass } from "./classes";

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${inputClass} ${className}`} {...props} />;
}
