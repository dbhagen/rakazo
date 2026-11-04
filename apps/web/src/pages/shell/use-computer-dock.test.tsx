// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useComputerDock } from "./use-computer-dock";

let container: HTMLDivElement;
let root: Root;
let handle: HTMLElement;
let latest: ReturnType<typeof useComputerDock>;

function Host() {
  latest = useComputerDock(100);
  return (
    <div>
      <button type="button" onClick={() => latest.setCollapsed(!latest.collapsed)}>
        toggle
      </button>
      <div data-testid="handle" {...latest.handleProps} />
    </div>
  );
}

function render() {
  act(() => root.render(<Host />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerHeight", 1000);
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    value: () => {},
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    value: () => {},
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    value: () => true,
    configurable: true,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render();
  handle = container.querySelector('[data-testid="handle"]')!;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function pointer(type: string, clientY: number, pointerId = 1) {
  handle.dispatchEvent(
    new PointerEvent(type, { bubbles: true, clientY, pointerId }) as unknown as Event,
  );
}

it("defaults to the bottom edge, and drags past the midpoint to snap to the top", () => {
  expect(latest.edge).toBe("bottom");
  act(() => pointer("pointerdown", 900));
  act(() => pointer("pointermove", 100));
  act(() => pointer("pointerup", 100));
  expect(latest.edge).toBe("top");
  render();
  expect(latest.edge).toBe("top");
});

it("drags within the same edge to resize, clamped to the minimum", () => {
  act(() => pointer("pointerdown", 900));
  act(() => pointer("pointermove", 850));
  act(() => pointer("pointerup", 850));
  // Dragging up from the bottom grows the panel toward the pointer's distance from the bottom.
  expect(latest.height).toBeGreaterThan(100);

  act(() => pointer("pointerdown", 999));
  act(() => pointer("pointermove", 999));
  act(() => pointer("pointerup", 999));
  expect(latest.height).toBe(100);
});

it("resizes with the arrow keys and snaps the edge with Home and End", () => {
  const before = latest.height;
  act(() =>
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
    ),
  );
  expect(latest.height).toBeGreaterThan(before);

  act(() =>
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
    ),
  );
  expect(latest.edge).toBe("top");

  act(() =>
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    ),
  );
  expect(latest.edge).toBe("bottom");
});

it("persists the collapsed state", () => {
  expect(latest.collapsed).toBe(false);
  act(() => container.querySelector("button")!.click());
  expect(latest.collapsed).toBe(true);
  render();
  expect(latest.collapsed).toBe(true);
});
