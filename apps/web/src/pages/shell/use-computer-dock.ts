import type { KeyboardEvent, PointerEvent } from "react";
import { useState } from "react";
import type { ComputerDockEdge } from "../../lib/computer-dock-pref";
import { readComputerDockPref, writeComputerDockPref } from "../../lib/computer-dock-pref";

/** The docked chat's max height, as a share of the viewport. */
export const COMPUTER_DOCK_MAX_HEIGHT_VH = 60;

function maxHeight(): number {
  return Math.round((window.innerHeight * COMPUTER_DOCK_MAX_HEIGHT_VH) / 100);
}

/**
 * The computer overlay's one dock panel: which edge it hugs, how tall it is, and whether it is
 * collapsed, all persisted. A drag on its handle resizes it and, dragged far enough, flips it to
 * the other edge; arrow keys resize, Home/End snap the edge.
 */
export function useComputerDock(minHeight: number) {
  const [pref, setPref] = useState(() => readComputerDockPref());
  const [drag, setDrag] = useState<{
    pointerId: number;
    edge: ComputerDockEdge;
    height: number;
  } | null>(null);

  function clamp(height: number) {
    return Math.max(minHeight, Math.min(maxHeight(), height));
  }

  const edge = drag?.edge ?? pref.edge;
  const height = clamp(drag?.height ?? pref.height);

  function commit(next: Partial<Pick<typeof pref, "edge" | "height" | "collapsed">>) {
    setPref((current) => {
      const merged = {
        edge: next.edge ?? current.edge,
        height: clamp(next.height ?? current.height),
        collapsed: next.collapsed ?? current.collapsed,
      };
      writeComputerDockPref(merged);
      return merged;
    });
  }

  /** Dragged past the opposite edge's own handle position, the dock flips there instead. */
  function atPointer(clientY: number): { edge: ComputerDockEdge; height: number } {
    const fromTop = clientY;
    const fromBottom = window.innerHeight - clientY;
    return fromTop < fromBottom
      ? { edge: "top", height: clamp(fromTop) }
      : { edge: "bottom", height: clamp(fromBottom) };
  }

  const handleProps = {
    role: "separator" as const,
    tabIndex: 0,
    "aria-orientation": "horizontal" as const,
    "aria-valuemin": minHeight,
    "aria-valuemax": maxHeight(),
    "aria-valuenow": Math.round(height),
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ pointerId: event.pointerId, edge, height });
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      if (drag?.pointerId !== event.pointerId) return;
      setDrag({ pointerId: event.pointerId, ...atPointer(event.clientY) });
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      if (drag?.pointerId !== event.pointerId) return;
      commit({ edge: drag.edge, height: drag.height });
      setDrag(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel(event: PointerEvent<HTMLElement>) {
      if (drag?.pointerId !== event.pointerId) return;
      setDrag(null);
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const step = 24 * (event.key === "ArrowUp" ? 1 : -1);
        commit({ height: height + step });
      } else if (event.key === "Home") {
        event.preventDefault();
        commit({ edge: "top" });
      } else if (event.key === "End") {
        event.preventDefault();
        commit({ edge: "bottom" });
      }
    },
  };

  return {
    edge,
    height,
    collapsed: pref.collapsed,
    setCollapsed: (collapsed: boolean) => commit({ collapsed }),
    dragging: drag !== null,
    handleProps,
  };
}
