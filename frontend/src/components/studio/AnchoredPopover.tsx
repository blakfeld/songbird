"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { menuPanelClass } from "./Menu";

const VIEWPORT_MARGIN_PX = 8;

// Clamped after layout because the panel's size is only known once it is rendered.
export function useViewportShift(open: boolean, anchor: { x: number; y: number }) {
  const root = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const rect = root.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const overflowX = anchor.x + rect.width + VIEWPORT_MARGIN_PX - window.innerWidth;
    const overflowY = anchor.y + rect.height + VIEWPORT_MARGIN_PX - window.innerHeight;
    setShift({ x: overflowX > 0 ? -overflowX : 0, y: overflowY > 0 ? -overflowY : 0 });
  }, [open, anchor.x, anchor.y]);
  return { root, shift };
}

const FOCUSABLE = 'button:not([aria-disabled="true"]), [role="slider"], [tabindex="0"]';

// A dialog rather than a menu because it holds sliders as well as buttons, which a `menu` may not own and whose
// arrow keys would fight the sliders'. It is not modal: Tab leaving either end closes it instead of trapping focus.
export function AnchoredPopover({
  open,
  anchor,
  label,
  onClose,
  returnFocusTo,
  anchorElement,
  panelClassName = "w-64",
  children,
}: {
  open: boolean;
  anchor: { x: number; y: number };
  label: string;
  onClose: () => void;
  returnFocusTo: () => HTMLElement | null;
  // The control that opened it counts as inside, so pressing it again closes the popover instead of reopening it.
  anchorElement?: () => HTMLElement | null;
  panelClassName?: string;
  children: ReactNode;
}) {
  const { root, shift } = useViewportShift(open, anchor);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("button")?.focus();
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (root.current?.contains(target) || anchorElement?.()?.contains(target)) return;
      close.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
    // The anchor getter is recreated per render; re-subscribing on it would refocus the first control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      returnFocusTo()?.focus();
    } else if (e.key === "Tab") {
      const items = [...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      if (document.activeElement === edge || items.length === 0) onClose();
    }
  };

  if (!open) return null;
  // Portalled because a container-type ancestor makes position: fixed relative to itself and scroll parents clip it.
  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ left: anchor.x + shift.x, top: anchor.y + shift.y }}
      className={`fixed z-50 ${menuPanelClass} ${panelClassName}`}
    >
      {children}
    </div>,
    document.body,
  );
}
