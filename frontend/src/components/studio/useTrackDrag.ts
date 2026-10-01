import { useCallback, useEffect, useRef, useState } from "react";

// Keeps a click on the grip from being read as a drag.
const DRAG_THRESHOLD_PX = 4;
const EDGE_PX = 32;
const SCROLL_STEP_PX = 16;
const INDICATOR_PX = 2;

function scrollBy(el: HTMLElement, dy: number) {
  el.scrollTop += dy;
}

export interface GripHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (e: React.PointerEvent<HTMLElement>) => void;
}

interface Session {
  trackId: string;
  from: number;
  startY: number;
  lastY: number;
  active: boolean;
  boundary: number;
  // Measured once at drag start so the targets stay put while the pointer moves.
  edges: number[];
  mids: number[];
  // The snapshots above go stale if the track order changes under the drag.
  order: string;
}

export function useTrackDrag({
  order,
  lanes,
  scroller,
  onDrop,
}: {
  order: string;
  lanes: React.RefObject<HTMLElement | null>;
  scroller: React.RefObject<HTMLElement | null>;
  onDrop: (trackId: string, toIndex: number) => void;
}) {
  const session = useRef<Session | null>(null);
  const frame = useRef(0);
  const currentOrder = useRef(order);
  const [state, setDrag] = useState<{
    trackId: string;
    from: number;
    boundary: number;
    edges: number[];
    order: string;
  } | null>(null);
  // Cleared rather than hidden, so undoing and redoing mid-drag cannot bring the stale visuals back.
  if (state && state.order !== order) setDrag(null);
  const drag = state && state.order === order ? state : null;
  const dragging = drag !== null;

  const stopScroll = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);

  const end = useCallback(() => {
    stopScroll();
    session.current = null;
    setDrag(null);
  }, [stopScroll]);

  useEffect(() => {
    currentOrder.current = order;
    stopScroll();
    session.current = null;
  }, [order, stopScroll]);

  useEffect(() => stopScroll, [stopScroll]);

  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !session.current) return;
      e.stopPropagation();
      end();
    };
    // Focus is not on the grip (Safari does not focus a button on click, and capture never moves focus).
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [dragging, end]);

  useEffect(() => {
    if (!dragging) return;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = "";
    };
  }, [dragging]);

  const measure = (s: Session) => {
    const wrapper = lanes.current;
    if (!wrapper) return false;
    const top = wrapper.getBoundingClientRect().top;
    const rects = Array.from(wrapper.querySelectorAll<HTMLElement>("[data-track-lane]")).map((el) =>
      el.getBoundingClientRect(),
    );
    if (rects.length === 0) return false;
    s.mids = rects.map((r) => (r.top + r.bottom) / 2 - top);
    s.edges = [...rects.map((r) => r.top - top), rects[rects.length - 1].bottom - top];
    return true;
  };

  const scrollDirection = (y: number) => {
    const view = scroller.current;
    if (!view) return 0;
    const rect = view.getBoundingClientRect();
    if (y < rect.top + EDGE_PX) return -1;
    if (y > rect.bottom - EDGE_PX) return 1;
    return 0;
  };

  // Reads the wrapper's rect each time, since its top moves with the scroll offset.
  const retarget = (s: Session) => {
    const y = s.lastY - (lanes.current?.getBoundingClientRect().top ?? 0);
    s.boundary = s.mids.filter((mid) => y > mid).length;
    setDrag({ trackId: s.trackId, from: s.from, boundary: s.boundary, edges: s.edges, order: s.order });
  };

  // Driven by frames rather than pointer events so a held pointer at the edge keeps scrolling.
  const tick = () => {
    const s = session.current;
    const view = scroller.current;
    const dir = s && view ? scrollDirection(s.lastY) : 0;
    if (!s || !view || dir === 0) {
      frame.current = 0;
      return;
    }
    scrollBy(view, dir * SCROLL_STEP_PX);
    retarget(s);
    frame.current = requestAnimationFrame(tick);
  };

  const gripProps = (trackId: string, from: number): GripHandlers => ({
    onPointerDown: (e) => {
      // Ctrl+click is the context menu on macOS, and it never delivers a pointer-up.
      if (e.button !== 0 || e.ctrlKey) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      session.current = {
        trackId,
        from,
        startY: e.clientY,
        lastY: e.clientY,
        active: false,
        boundary: from,
        edges: [],
        mids: [],
        order: currentOrder.current,
      };
    },
    onPointerMove: (e) => {
      const s = session.current;
      if (!s) return;
      // A release can go undelivered once capture is lost, so the next move checks the buttons.
      if ((e.buttons & 1) === 0) return end();
      if (!s.active) {
        if (Math.abs(e.clientY - s.startY) < DRAG_THRESHOLD_PX) return;
        if (!measure(s)) return;
        s.active = true;
      }
      s.lastY = e.clientY;
      retarget(s);
      if (frame.current === 0 && scrollDirection(s.lastY) !== 0) frame.current = requestAnimationFrame(tick);
    },
    onPointerUp: () => {
      const s = session.current;
      if (!s) return;
      end();
      if (!s.active) return;
      onDrop(s.trackId, s.boundary > s.from ? s.boundary - 1 : s.boundary);
    },
    onPointerCancel: end,
    onLostPointerCapture: end,
  });

  // Dropping beside its own slot changes nothing, so there is nothing to point at.
  const changes = drag !== null && drag.boundary !== drag.from && drag.boundary !== drag.from + 1;
  let indicatorTop: number | null = null;
  if (changes) {
    const { edges } = drag;
    const last = edges.length - 1;
    indicatorTop =
      drag.boundary === 0 ? 0 : drag.boundary === last ? edges[last] - INDICATOR_PX : edges[drag.boundary] - 1;
  }

  return { draggingId: drag?.trackId ?? null, indicatorTop, gripProps };
}
