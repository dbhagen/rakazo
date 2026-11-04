/**
 * Coordinates the computer screen between the main window and a popped-out window for the same
 * bot, over a BroadcastChannel named per bot (pattern: mcp-connect.ts's MCP_OAUTH_CHANNEL). Only
 * one side shows the live iframe at a time; the other shows a placeholder.
 *
 * Protocol (all messages are `{ type }`, no payload needed beyond the channel's own scoping):
 * - `claim`: the pop-out announces it is open, before it fetches its own screen URL. The main
 *   window stops showing the live iframe and releases control if it held it.
 * - `return`: the main window asks the pop-out to hand the screen back. The pop-out closes itself
 *   (or shows "Returned to the main window" if `window.close()` is blocked by the browser).
 * - `heartbeat`: the pop-out sends this every `HEARTBEAT_INTERVAL_MS` while it holds the screen,
 *   so the main window can tell a closed pop-out (no more `beforeunload`/`pagehide`, e.g. a crash)
 *   from one still open.
 * - `release`: the pop-out sends this once, on `pagehide` or `beforeunload`, so the main window
 *   does not have to wait out the heartbeat timeout for an orderly close.
 */

export const HEARTBEAT_INTERVAL_MS = 3_000;
/** Missing this many heartbeats in a row means the pop-out is gone, not just slow. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

export type PopOutMessage = { type: "claim" | "return" | "heartbeat" | "release" };

export function popOutChannelName(botId: string): string {
  return `rakazo-computer-${botId}`;
}

/** The feature degrades to "no pop-out button" rather than an uncoordinated second viewer. */
export function supportsPopOutChannel(): boolean {
  return typeof BroadcastChannel !== "undefined";
}

function openChannel(botId: string): BroadcastChannel {
  return new BroadcastChannel(popOutChannelName(botId));
}

function isPopOutMessage(data: unknown): data is PopOutMessage {
  const type = (data as { type?: unknown } | null)?.type;
  return type === "claim" || type === "return" || type === "heartbeat" || type === "release";
}

export type PopOutHostState = "main" | "popped-out" | "lost";

/**
 * The main window's side: tracks whether a pop-out currently holds the screen, and lets the user
 * ask for it back. `onStateChange` fires whenever the state the UI should show changes:
 * - "main": nothing popped out; show the live screen here.
 * - "popped-out": a pop-out claimed the screen and is heard from; show the placeholder.
 * - "lost": a pop-out claimed the screen but stopped heartbeating; offer "Reconnect here".
 */
export function createPopOutHost(
  botId: string,
  onStateChange: (state: PopOutHostState) => void,
): { requestReturn: () => void; reacquire: () => void; close: () => void } {
  if (!supportsPopOutChannel()) {
    return { requestReturn: () => {}, reacquire: () => {}, close: () => {} };
  }
  const channel = openChannel(botId);
  let state: PopOutHostState = "main";
  let timer: ReturnType<typeof setTimeout> | undefined;
  function setState(next: PopOutHostState) {
    if (state === next) return;
    state = next;
    onStateChange(state);
  }
  function scheduleTimeout() {
    clearTimeout(timer);
    timer = setTimeout(() => setState("lost"), HEARTBEAT_TIMEOUT_MS);
  }
  channel.onmessage = (event: MessageEvent) => {
    if (!isPopOutMessage(event.data)) return;
    if (event.data.type === "claim") {
      setState("popped-out");
      scheduleTimeout();
    } else if (event.data.type === "heartbeat") {
      // Only a pop-out we believe is present resets the timeout; one claimed by another tab's
      // reacquire race is ignored rather than un-losing a window the user already took back.
      if (state !== "main") scheduleTimeout();
    } else if (event.data.type === "release") {
      clearTimeout(timer);
      setState("main");
    }
  };
  return {
    /** Asks the pop-out to close and hand the screen back; the main window re-fetches on `return`
     * being acknowledged, which here is simply going back to showing the live screen itself. */
    requestReturn() {
      channel.postMessage({ type: "return" } satisfies PopOutMessage);
      clearTimeout(timer);
      setState("main");
    },
    /** The user chose to reconnect here after the pop-out went quiet; stop waiting on it. */
    reacquire() {
      clearTimeout(timer);
      setState("main");
    },
    close() {
      clearTimeout(timer);
      channel.close();
    },
  };
}

/**
 * The pop-out window's side: claims the screen on load, heartbeats while open, and releases on
 * close. `onReturn` fires when the main window asks for the screen back.
 */
export function createPopOutClient(botId: string, onReturn: () => void): { close: () => void } {
  if (!supportsPopOutChannel()) return { close: () => {} };
  const channel = openChannel(botId);
  channel.postMessage({ type: "claim" } satisfies PopOutMessage);
  const heartbeat = setInterval(() => {
    channel.postMessage({ type: "heartbeat" } satisfies PopOutMessage);
  }, HEARTBEAT_INTERVAL_MS);
  channel.onmessage = (event: MessageEvent) => {
    if (!isPopOutMessage(event.data)) return;
    if (event.data.type === "return") onReturn();
  };
  function release() {
    channel.postMessage({ type: "release" } satisfies PopOutMessage);
  }
  window.addEventListener("pagehide", release);
  window.addEventListener("beforeunload", release);
  return {
    close() {
      clearInterval(heartbeat);
      window.removeEventListener("pagehide", release);
      window.removeEventListener("beforeunload", release);
      channel.close();
    },
  };
}
