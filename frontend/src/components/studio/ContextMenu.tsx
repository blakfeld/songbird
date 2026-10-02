"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useViewportShift } from "./AnchoredPopover";
import { menuPanelClass, useMenuBehavior } from "./Menu";

// Right-click and Shift+F10 have no trigger button to hang a Menu from, so the panel is placed at a point.
export function ContextMenu({
  open,
  anchor,
  label,
  onClose,
  returnFocusTo,
  panelClassName = "w-64",
  children,
}: {
  open: boolean;
  anchor: { x: number; y: number };
  label: string;
  onClose: () => void;
  returnFocusTo: () => HTMLElement | null;
  panelClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
  const { root, shift } = useViewportShift(open, anchor);

  const onKeyDown = useMenuBehavior(open, root, (returnFocus) => {
    onClose();
    if (returnFocus) returnFocusTo()?.focus();
  });

  if (!open) return null;
  // Portalled because a container-type ancestor makes position: fixed relative to itself and scroll parents clip it.
  return createPortal(
    <div
      ref={root}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ left: anchor.x + shift.x, top: anchor.y + shift.y }}
      className={`fixed z-50 ${menuPanelClass} ${panelClassName}`}
    >
      {children(onClose)}
    </div>,
    document.body,
  );
}
