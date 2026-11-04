import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { PAGE_RUNTIME_PATH, pageReply, pageReplyText, pageViewerDocument } from "@rakazo/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useSearchParams } from "react-router-dom";
import { useSpaceQueries } from "./query";
import { errorCode } from "./user-error";

/** The search parameter naming the page open full screen over a chat. */
export const PAGE_PARAM = "page";

function readTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function readSurface(on: "card" | "background"): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${on}`).trim();
}

export function useMedia(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

async function fetchPageRuntime(): Promise<string> {
  const response = await fetch(PAGE_RUNTIME_PATH);
  if (!response.ok) throw new Error(`Page runtime returned ${response.status}`);
  return response.text();
}

/**
 * A page's compiled code as the sandboxed viewer's document; null until the runtime has loaded.
 * `failed` says the runtime could not be fetched, and `retry` fetches it again.
 */
export function usePageDocument(
  code: string | undefined,
  /** The app surface behind the page; a tablet sheet sits on the background. */
  on: "card" | "background" = "card",
  /** The chat's composer is beside the page, so its reply buttons can fill it. */
  reply = false,
  /** Pixels a composer docked over the page's bottom covers. */
  bottomInset = 0,
): { document: string | null; failed: boolean; retry: () => void } {
  const { t, i18n } = useLingui();
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "dark" as const);
  // The surface follows the theme, so it is read again whenever the theme changes.
  const surface = useMemo(() => (theme ? readSurface(on) : ""), [theme, on]);
  const touch = useMedia("(pointer: coarse)");
  // Fetched again on every mount; the browser revalidates the server's no-cache runtime.
  const runtime = useQuery({ queryKey: ["page-runtime"], queryFn: fetchPageRuntime });
  const errorTitle = t`This page couldn't be shown.`;
  const viewerDocument = useMemo(
    () =>
      runtime.data === undefined || code === undefined
        ? null
        : pageViewerDocument({
            runtime: runtime.data,
            code,
            theme,
            errorTitle,
            surface,
            touch,
            reply,
            bottomInset,
            lang: i18n.locale,
          }),
    [runtime.data, code, theme, errorTitle, surface, touch, reply, bottomInset, i18n.locale],
  );
  const { refetch } = runtime;
  const retry = useCallback(() => void refetch(), [refetch]);
  return { document: viewerDocument, failed: runtime.isError && runtime.data === undefined, retry };
}

type Dock = { node: HTMLElement | null; page: { id: string; title: string } | null };

/**
 * One element the composer can portal into, claimed by at most one caller at a time: a page, the
 * full-screen computer overlay, or whatever else needs the one Composer beside it. Claims stack;
 * the most recently claimed with a node wins, and releasing one falls back to whichever is next.
 */
function createDockNodeStack() {
  const order: string[] = [];
  const nodes = new Map<string, HTMLElement | null>();
  const listeners = new Set<() => void>();
  function notify() {
    for (const listener of listeners) listener();
  }
  function top(): HTMLElement | null {
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const id = order[index];
      const node = id === undefined ? undefined : nodes.get(id);
      if (node) return node;
    }
    return null;
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: top,
    claim(id: string) {
      // Re-claiming an id already on the stack (such as the one permanent "page" claim) moves it
      // to the top again rather than duplicating it.
      const existing = order.indexOf(id);
      if (existing !== -1) order.splice(existing, 1);
      order.push(id);
      nodes.set(id, null);
      notify();
      return {
        set(node: HTMLElement | null) {
          if (nodes.get(id) === node) return;
          const hadNode = nodes.get(id) !== null && nodes.get(id) !== undefined;
          nodes.set(id, node);
          // Going from no node to a real one makes this claim the most recently opened: it jumps
          // to the top of the stack rather than waiting below whoever claimed earlier but already
          // has a node, such as the computer overlay claimed before a page opens.
          if (node && !hadNode) {
            const index = order.indexOf(id);
            if (index !== -1) order.splice(index, 1);
            order.push(id);
          }
          notify();
        },
        release() {
          const wasTop = top() === nodes.get(id) && nodes.get(id) !== null;
          const index = order.indexOf(id);
          if (index !== -1) order.splice(index, 1);
          nodes.delete(id);
          if (wasTop) notify();
        },
      };
    },
  };
}
export type DockClaim = ReturnType<ReturnType<typeof createDockNodeStack>["claim"]>;

/**
 * One chat's open-page state: what opened the page (for focus), a Share asked for with it, and
 * where the composer docks. Shared by the shell, the open page and the composer through context.
 */
export function createPageSession() {
  let opener: { element: HTMLElement; ring: boolean } | null = null;
  let shareRequest: string | null = null;
  let page: { id: string; title: string } | null = null;
  const nodeStack = createDockNodeStack();
  // The page's own claim sits at the bottom of the stack for the session's whole life; it is
  // never released, so a claimant such as the computer overlay falls back to it on release.
  const pageClaim = nodeStack.claim("page");
  let dockSnapshot: Dock = { node: null, page: null };
  const replyListeners = new Set<(text: string) => void>();
  return {
    rememberOpener() {
      const element = document.activeElement;
      opener =
        element instanceof HTMLElement
          ? { element, ring: element.matches(":focus-visible") }
          : null;
    },
    /** Focus goes back to what opened the page, with a ring only if it had one. */
    restoreFocus() {
      if (!opener?.element.isConnected) return true;
      opener.element.focus({ focusVisible: opener.ring } as FocusOptions);
      return false;
    },
    askShare(pageId: string | null) {
      shareRequest = pageId;
    },
    /** Share asked for with this page, taken once so history never pops it open again. */
    takeShare(pageId: string) {
      const asked = shareRequest === pageId;
      shareRequest = null;
      return asked;
    },
    dock: {
      set(next: Partial<Dock>) {
        if ("node" in next) pageClaim.set(next.node ?? null);
        if ("page" in next) {
          const nextPage = next.page ?? null;
          if (nextPage?.id === page?.id && nextPage?.title === page?.title) return;
          page = nextPage;
        }
      },
      subscribe: nodeStack.subscribe,
      // Cached rather than built fresh each call: useSyncExternalStore needs a stable reference
      // when nothing has changed, or it re-renders forever.
      get: (): Dock => {
        if (dockSnapshot.node !== nodeStack.get() || dockSnapshot.page !== page)
          dockSnapshot = { node: nodeStack.get(), page };
        return dockSnapshot;
      },
      /**
       * A claimant other than the page (such as the full-screen computer overlay) takes the one
       * composer dock while it holds the claim; releasing it falls back to whoever is below.
       */
      claim: (id: string) => nodeStack.claim(id),
    },
    /** A page's reply button hands its text to the chat's composer; the user still sends it. */
    offerReply(text: unknown) {
      const clean = pageReplyText(text);
      if (!clean || !page) return;
      for (const listener of replyListeners) listener(clean);
    },
    subscribeReply(listener: (text: string) => void) {
      replyListeners.add(listener);
      return () => {
        replyListeners.delete(listener);
      };
    },
    /** From the open page: reply to its card, or name the page if this chat has none. */
    send(
      text: string,
      messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
      chosenReplyId?: string,
    ): { text: string; replyToMessageId?: string } {
      return pageReply(text, messages, page, chosenReplyId);
    },
  };
}
export type PageSession = ReturnType<typeof createPageSession>;

type OpenPage = (pageId: string, options?: { share?: boolean }) => void;
type Pages = { open: OpenPage; session: PageSession };

const PagesContext = createContext<Pages | null>(null);

/** The chat's pages; outside a chat nothing opens. */
export const PagesProvider = PagesContext.Provider;

export function useOpenPage(): OpenPage {
  return useContext(PagesContext)?.open ?? noop;
}
const noop: OpenPage = () => {};

export function usePageSession(): PageSession | null {
  return useContext(PagesContext)?.session ?? null;
}

/**
 * Claims the chat's one composer dock while `active`, so something other than a page (the
 * full-screen computer overlay) can host the same Composer; releasing it on close or unmount
 * falls back to whatever was claiming the dock before, such as an open page.
 */
export function useDockClaim(active: boolean, id: string): (node: HTMLElement | null) => void {
  const session = usePageSession();
  const claimRef = useRef<DockClaim | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (active) return;
    claimRef.current?.release();
    claimRef.current = null;
  }, [active]);
  // Cleanup only, so remounting under the same id (StrictMode, fast refresh) doesn't release a
  // claim another instance of this hook has since taken over.
  useEffect(
    () => () => {
      claimRef.current?.release();
      claimRef.current = null;
    },
    [],
  );
  return useCallback(
    (node: HTMLElement | null) => {
      if (!session || !activeRef.current) return;
      // Claimed lazily on the first node, since ref callbacks commit before effects run.
      claimRef.current ??= session.dock.claim(id);
      claimRef.current.set(node);
    },
    [session, id],
  );
}

/** Opens a page by URL, remembering what opened it so focus can go back there. */
export function usePagesForChat(): Pages {
  const [session] = useState(createPageSession);
  const [, setSearchParams] = useSearchParams();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const open = useCallback<OpenPage>(
    (pageId, options) => {
      // A page known to be deleted (its card says so) opens nothing, from a card or a link chip.
      const known = queryClient.getQueryState(queries.pages.get.queryKey({ input: { pageId } }));
      if (errorCode(known?.error) === "NOT_FOUND") return;
      session.rememberOpener();
      session.askShare(options?.share ? pageId : null);
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.set(PAGE_PARAM, pageId);
        return next;
      });
    },
    [session, setSearchParams, queries, queryClient],
  );
  return useMemo(() => ({ open, session }), [open, session]);
}
