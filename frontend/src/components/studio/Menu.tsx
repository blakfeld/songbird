"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { focusRing } from "@/components/ui/classes";

export const menuItemClass = `flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-zinc-900 hover:bg-zinc-100 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 dark:text-zinc-100 dark:hover:bg-zinc-900 ${focusRing}`;

// Arrow keys move between items and Tab closes, so the menu never traps keyboard users.
export function Menu({
  label,
  trigger,
  triggerClassName,
  disabled = false,
  align = "left",
  panelClassName = "w-56",
  children,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName: string;
  disabled?: boolean;
  align?: "left" | "right";
  panelClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  const dismiss = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [
        ...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
      ];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  }

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={label}
          className={`absolute z-50 mt-1 max-h-80 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950 ${align === "right" ? "right-0" : "left-0"} ${panelClassName}`}
        >
          {children(dismiss)}
        </div>
      )}
    </div>
  );
}
