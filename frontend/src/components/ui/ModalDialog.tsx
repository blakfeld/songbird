"use client";

import { useEffect, useRef, type ReactNode } from "react";

// The children mount only while open, so forms inside always start from fresh state.
export function ModalDialog({
  open,
  onClose,
  label,
  labelledBy,
  role,
  className = "m-auto w-full max-w-sm rounded-2xl p-6",
  children,
}: {
  open: boolean;
  onClose: () => void;
  label?: string;
  labelledBy?: string;
  role?: "dialog" | "alertdialog";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (dialog.showModal) dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (dialog.close) dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      role={role}
      aria-label={label}
      aria-labelledby={labelledBy}
      onClose={onClose}
      className={`border border-zinc-200 bg-white text-zinc-900 backdrop:bg-black/50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 ${className}`}
    >
      {open && children}
    </dialog>
  );
}
