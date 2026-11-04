// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Spinner: () => null,
}));
vi.mock("../../components/ComputerMaintenanceActions", () => ({
  ComputerMaintenanceActions: () => null,
}));

import { createPopOutClient } from "../../lib/computer-pop-out-channel";
import type { ComputerControls, ComputerState } from "./use-computer";
import { useComputerControls, useComputerState } from "./use-computer";

let container: HTMLDivElement;
let root: Root;
let state: ComputerState;
let controls: ComputerControls;
const bot = { id: "bot-1", name: "Bot" } as Bot;
const screenUrl = vi.fn(async () => ({ url: "https://screen.example/novnc/" }));
const release = vi.fn(async () => undefined);
const status = vi.fn(async () => ({ botId: "bot-1", state: "running" }) as never);

function Harness() {
  state = useComputerState({
    rpc: { computer: { screenUrl } } as never,
    panel: "computer",
    activeId: "bot-1",
    activeBotId: { current: "bot-1" },
  });
  controls = useComputerControls({
    rpc: {
      computer: { screenUrl, release, status, heartbeat: vi.fn(async () => undefined) },
    } as never,
    state,
    panel: "computer",
    active: bot,
    bots: [bot],
    botsRef: { current: [bot] },
    activeBotId: { current: "bot-1" },
    activeGroupId: { current: undefined },
    runStatus: undefined,
    sandboxProvider: undefined,
    refreshThread: vi.fn(async () => ({}) as never),
    refreshGroupThread: vi.fn(async () => ({}) as never),
  });
  return null;
}

/** Waits out BroadcastChannel's real message delivery, which fake timers don't control. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  screenUrl.mockClear();
  release.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await act(async () => {
    await state.refreshComputerScreen("bot-1");
  });
  screenUrl.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("stops showing the live screen and fetching it once a pop-out claims it, then re-fetches on return", async () => {
  const client = createPopOutClient("bot-1", () => {});
  await act(async () => flush());
  expect(controls.popOutState).toBe("popped-out");
  expect(controls.embeddedScreenUrl).toBeNull();
  expect(controls.popOutNotice).toBeTruthy();

  await act(async () => {
    await state.refreshComputerScreen("bot-1");
  });
  expect(screenUrl).not.toHaveBeenCalled();

  controls.requestReturnFromPopOut?.();
  await act(async () => flush());
  expect(controls.popOutState).toBe("main");
  await act(async () => flush());
  expect(screenUrl).toHaveBeenCalled();
  client.close();
});

it("releases control held here once a pop-out claims the screen", async () => {
  await act(async () => {
    state.commitComputer({
      botId: "bot-1",
      state: "running",
      controlHolder: "user",
      controlBotId: "bot-1",
    } as never);
  });
  const client = createPopOutClient("bot-1", () => {});
  await act(async () => flush());
  expect(release).toHaveBeenCalledWith({ botId: "bot-1", reason: undefined });
  client.close();
});

it("shows Reconnect once the pop-out goes quiet, and only re-acquires on click", async () => {
  const client = createPopOutClient("bot-1", () => {});
  await act(async () => flush());
  expect(controls.popOutState).toBe("popped-out");
  // A crash stops the heartbeat without an orderly "release"; the host waits out the timeout.
  client.close();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(controls.popOutState).toBe("lost");
  expect(screenUrl).not.toHaveBeenCalled();

  controls.reacquireFromPopOut?.();
  await act(async () => flush());
  expect(controls.popOutState).toBe("main");
});
