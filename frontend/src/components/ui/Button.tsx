import type { ComponentProps } from "react";
import { focusRing } from "./classes";

const variants = {
  primary:
    "rounded-full bg-black px-5 py-2.5 text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200",
  secondary:
    "rounded-full border border-zinc-300 bg-white px-4 py-2 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900",
} as const;

export function buttonClass(variant: keyof typeof variants = "secondary") {
  return `inline-flex items-center justify-center gap-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${focusRing}`;
}

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof variants }) {
  return (
    <button
      type={type}
      className={`${buttonClass(variant)} ${className}`}
      {...props}
    />
  );
}
