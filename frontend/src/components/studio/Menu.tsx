"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { focusRing } from "@/components/ui/classes";

export const menuItemClass = `flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-zinc-900 hover:bg-zinc-100 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 dark:text-zinc-100 dark:hover:bg-zinc-900 ${focusRing}`;

export const menuPanelClass =
  "max-h-80 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950";

// Shared by the trigger menu and the context menu so their keyboard and dismissal rules cannot drift apart.
export function useMenuBehavior(
  open: boolean,
  root: React.RefObject<HTMLElement | null>,
  onClose: (returnFocus: boolean) => void,
) {
  useEffect(() => {
    if (!open) return;
    // Radio menus open on the checked item (ARIA APG); plain menus have none and fall back to the first.
    const first =
      root.current?.querySelector<HTMLElement>('[role^="menuitem"][aria-checked="true"]') ??
      root.current?.querySelector<HTMLElement>('[role^="menuitem"]');
    first?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
    // The close callback is recreated per render; re-subscribing on it would refocus the first item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, root]);

  return function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === "Tab") {
      onClose(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const items = [...(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
      if (e.key === "Home") return items[0]?.focus();
      if (e.key === "End") return items[items.length - 1]?.focus();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  };
}

// Arrow keys move between items and Tab closes, so the menu never traps keyboard users.
export function Menu({
  label,
  triggerLabel = label,
  trigger,
  triggerClassName,
  disabled = false,
  defaultOpen = false,
  align = "left",
  panelClassName = "w-56",
  children,
}: {
  label: string;
  // Separate so a trigger's accessible name can contain its visible text while the panel keeps the plain name.
  triggerLabel?: string;
  trigger: ReactNode;
  triggerClassName: string;
  disabled?: boolean;
  // For a menu that replaces the control which just granted it access, so keyboard focus lands inside it.
  defaultOpen?: boolean;
  align?: "left" | "right";
  panelClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  const dismiss = () => setOpen(false);

  const onKeyDown = useMenuBehavior(open, root, (returnFocus) => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  });

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        aria-label={triggerLabel}
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
          className={`absolute z-50 mt-1 ${menuPanelClass} ${align === "right" ? "right-0" : "left-0"} ${panelClassName}`}
        >
          {children(dismiss)}
        </div>
      )}
    </div>
  );
}
