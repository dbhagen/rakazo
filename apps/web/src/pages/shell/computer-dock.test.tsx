// @vitest-environment jsdom

import type { ThreadMessage } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPageSession, PagesProvider } from "../../lib/pages";
import { rpc } from "../../lib/rpc";
import { ComputerDock } from "./computer-dock";

const skills = vi.hoisted(() => ({
  updateDraft: vi.fn(async () => ({})),
  save: vi.fn(async () => ({})),
  testRun: vi.fn(async () => ({ runId: "run" })),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { skills } }));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function askMessage(id: string): ThreadMessage {
  return {
    id,
    threadId: "thread",
    seq: 1,
    role: "bot",
    createdAt: new Date().toISOString(),
    blocks: [
      {
        kind: "ask",
        text: "Delete the file?",
        status: "pending",
        actions: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      },
    ],
  };
}

function baseProps(
  overrides: Partial<ComponentProps<typeof ComputerDock>["messageProps"]> = {},
): ComponentProps<typeof ComputerDock>["messageProps"] {
  return {
    artifactTarget: { botId: "bot-1" },
    answerableAskIds: new Set(["m1"]),
    dismissableAskIds: new Set(),
    onAnswer: vi.fn(async () => undefined),
    onOpenBot: vi.fn(),
    onOpenPeerMessages: vi.fn(),
    peerBot: () => ({ color: "orange" }),
    onRefresh: vi.fn(async () => undefined),
    onBotChanged: vi.fn(async () => undefined),
    onAddRoutine: vi.fn(),
    voiceReady: false,
    onSpeak: vi.fn(),
    onOpenComputer: vi.fn(),
    rpc,
    showToolActivity: false,
    onReply: vi.fn(),
    onMarkUnread: vi.fn(),
    onReact: vi.fn(async () => undefined),
    ...overrides,
  };
}

it("shows the last message's card with working answer buttons", async () => {
  const onAnswer: ComponentProps<typeof ComputerDock>["messageProps"]["onAnswer"] = vi.fn(
    async () => undefined,
  );
  await act(async () => {
    root.render(
      <ComputerDock messages={[askMessage("m1")]} messageProps={baseProps({ onAnswer })} />,
    );
  });
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Yes"),
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
  expect(vi.mocked(onAnswer).mock.calls[0]?.[0]).toMatchObject({ id: "m1" });
  expect(vi.mocked(onAnswer).mock.calls[0]?.[1]).toBe("yes");
});

it("collapses to just the composer row and persists the collapsed state", async () => {
  await act(async () => {
    root.render(<ComputerDock messages={[askMessage("m1")]} messageProps={baseProps()} />);
  });
  expect(
    container.querySelector('[data-testid="computer-dock"] [role="separator"]'),
  ).not.toBeNull();
  const toggle = [...container.querySelectorAll("button")].find((b) =>
    b.getAttribute("aria-label")?.includes("Collapse"),
  );
  await act(async () => toggle?.click());
  expect(container.querySelector('[data-testid="computer-dock"] [role="separator"]')).toBeNull();

  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => {
    root.render(<ComputerDock messages={[askMessage("m1")]} messageProps={baseProps()} />);
  });
  expect(container.querySelector('[data-testid="computer-dock"] [role="separator"]')).toBeNull();
});

it("hosts the chat's one composer dock while open", async () => {
  const session = createPageSession();
  await act(async () => {
    root.render(
      <PagesProvider value={{ open: () => undefined, session }}>
        <ComputerDock messages={[]} messageProps={baseProps()} />
      </PagesProvider>,
    );
  });
  // The computer overlay's claim replaces the "page" claim at the top of the dock stack.
  expect(session.dock.get().node).toBe(
    container.querySelector('[data-testid="computer-dock-composer"] > div'),
  );
});
