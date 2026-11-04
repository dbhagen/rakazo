// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPopOutClient,
  createPopOutHost,
  HEARTBEAT_TIMEOUT_MS,
  supportsPopOutChannel,
} from "./computer-pop-out-channel";

beforeEach(() => {
  // Only timers are faked; BroadcastChannel delivery runs on real microtasks/setImmediate, which
  // `flush()` below waits out directly instead of through vi's (unrelated) fake clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Waits out BroadcastChannel's real message delivery, which fake timers don't control. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("supportsPopOutChannel", () => {
  it("is true when BroadcastChannel exists", () => {
    expect(supportsPopOutChannel()).toBe(true);
  });
});

describe("pop-out BroadcastChannel protocol", () => {
  it("moves the main window to the placeholder once the pop-out claims the screen", async () => {
    const states: string[] = [];
    const host = createPopOutHost("bot-1", (state) => states.push(state));
    const client = createPopOutClient("bot-1", () => {});
    await flush();
    expect(states).toEqual(["popped-out"]);
    client.close();
    host.close();
  });

  it("brings the main window back when it asks the pop-out to return", async () => {
    const states: string[] = [];
    const host = createPopOutHost("bot-2", (state) => states.push(state));
    const returned = vi.fn();
    const client = createPopOutClient("bot-2", returned);
    await flush();
    expect(states).toEqual(["popped-out"]);
    host.requestReturn();
    await flush();
    expect(returned).toHaveBeenCalledOnce();
    expect(states).toEqual(["popped-out", "main"]);
    client.close();
    host.close();
  });

  it("treats a missed heartbeat window as the pop-out being gone", async () => {
    const states: string[] = [];
    const host = createPopOutHost("bot-3", (state) => states.push(state));
    const client = createPopOutClient("bot-3", () => {});
    await flush();
    expect(states).toEqual(["popped-out"]);
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + 1);
    await flush();
    expect(states).toEqual(["popped-out", "lost"]);
    // Reconnecting here (user action) stops waiting on the stale pop-out without a message.
    host.reacquire();
    expect(states).toEqual(["popped-out", "lost", "main"]);
    client.close();
    host.close();
  });

  it("stays claimed while heartbeats keep arriving", async () => {
    const states: string[] = [];
    const host = createPopOutHost("bot-4", (state) => states.push(state));
    const client = createPopOutClient("bot-4", () => {});
    await flush();
    expect(states).toEqual(["popped-out"]);
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS - 500);
    await flush();
    expect(states).toEqual(["popped-out"]);
    client.close();
    host.close();
  });

  it("returns to main as soon as the pop-out releases on close, without waiting out the timeout", async () => {
    const states: string[] = [];
    const host = createPopOutHost("bot-5", (state) => states.push(state));
    const client = createPopOutClient("bot-5", () => {});
    await flush();
    expect(states).toEqual(["popped-out"]);
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(states).toEqual(["popped-out", "main"]);
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + 1);
    await flush();
    // No further transition: the timeout was cleared on release.
    expect(states).toEqual(["popped-out", "main"]);
    client.close();
    host.close();
  });
});
