"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { menuPanelClass, useMenuBehavior } from "./Menu";

const VIEWPORT_MARGIN_PX = 8;

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
  const root = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState({ x: 0, y: 0 });

  const onKeyDown = useMenuBehavior(open, root, (returnFocus) => {
    onClose();
    if (returnFocus) returnFocusTo()?.focus();
  });

  // Clamped after layout because the panel's size is only known once it is rendered.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = root.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const overflowX = anchor.x + rect.width + VIEWPORT_MARGIN_PX - window.innerWidth;
    const overflowY = anchor.y + rect.height + VIEWPORT_MARGIN_PX - window.innerHeight;
    setShift({
      x: overflowX > 0 ? -overflowX : 0,
      y: overflowY > 0 ? -overflowY : 0,
    });
  }, [open, anchor.x, anchor.y]);

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
