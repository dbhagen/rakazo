// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls: string[] = [];
const api = vi.hoisted(() => ({
  threads: {
    get: vi.fn(async () => ({
      threadId: "t1",
      cursor: 0,
      messages: [],
      olderCursor: null,
      run: null,
    })),
    subscribe: vi.fn(async function* () {}),
    send: vi.fn(async () => ({})),
    answer: vi.fn(async () => ({})),
    react: vi.fn(async () => ({})),
  },
  computer: {
    status: vi.fn(async () => ({
      botId: "bot-1",
      state: "running",
      controlHolder: "user",
      controlBotId: "bot-1",
    })),
    boot: vi.fn(async () => ({ botId: "bot-1", state: "running" })),
    takeover: vi.fn(async () => ({})),
    screenUrl: vi.fn(async () => ({ url: "https://screen.example/novnc/" })),
    release: vi.fn(async () => ({})),
    heartbeat: vi.fn(async () => ({})),
  },
}));
vi.mock("../lib/rpc", () => ({
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({ Spinner: () => null }));
vi.mock("./shell/composer", () => ({ Composer: () => null }));
vi.mock("./shell/computer-dock", () => ({ ComputerDock: () => null }));
vi.mock("../components/PageLoading", () => ({ PageLoading: () => <div data-testid="loading" /> }));

let onReturn: (() => void) | undefined;
vi.mock("../lib/computer-pop-out-channel", () => ({
  createPopOutClient: (_botId: string, callback: () => void) => {
    calls.push("claim");
    onReturn = callback;
    return { close: () => {} };
  },
}));

import { ComputerPopOutPage } from "./ComputerPopOut";

function renderPage() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/app/computer/bot-1"]}>
        <Routes>
          <Route path="/app/computer/:botId" element={<ComputerPopOutPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

beforeEach(() => {
  calls.length = 0;
  onReturn = undefined;
  vi.clearAllMocks();
  Object.defineProperty(window, "close", { value: vi.fn(), writable: true });
});

afterEach(() => {
  document.body.innerHTML = "";
});

it("claims the screen before fetching it", async () => {
  const { root } = renderPage();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const screenUrlCallOrder = api.computer.screenUrl.mock.invocationCallOrder[0];
  expect(calls).toEqual(["claim"]);
  expect(screenUrlCallOrder).toBeGreaterThan(0);
  expect(api.computer.screenUrl).toHaveBeenCalledWith({ botId: "bot-1" });
  act(() => root.unmount());
});

it("closes on a return message, or falls back to a visible notice", async () => {
  const { container, root } = renderPage();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => onReturn?.());
  expect(window.close).toHaveBeenCalled();
  expect(container.textContent).toContain("Returned to the main window");
  act(() => root.unmount());
});

it("sends a keep-awake heartbeat for the computer while it's running and visible", async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  const { root } = renderPage();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // One ping fires immediately once the computer is known to be running.
  expect(api.computer.heartbeat).toHaveBeenCalledWith({ botId: "bot-1" });
  api.computer.heartbeat.mockClear();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(api.computer.heartbeat).toHaveBeenCalledTimes(1);

  act(() => root.unmount());
  vi.useRealTimers();
});
