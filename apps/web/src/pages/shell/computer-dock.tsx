import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadMessage } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { ChevronDown, ChevronUp, GripHorizontal } from "lucide-react";
import type { ComponentProps } from "react";
import { useEffect, useRef } from "react";
import { useDockClaim } from "../../lib/pages";
import { transcriptIsNearEnd } from "../../lib/transcript-scroll";
import { MessageView } from "./message-view";
import { useComputerDock } from "./use-computer-dock";

/** The composer plus one bubble is the smallest the dock can shrink to while expanded. */
const COMPUTER_DOCK_MIN_HEIGHT = 180;
/** How many of the thread's newest messages the dock keeps mounted. */
const COMPUTER_DOCK_MESSAGE_COUNT = 5;

export type ComputerDockMessageProps = Omit<
  ComponentProps<typeof MessageView>,
  "message" | "canAnswer" | "canDismiss" | "speaking"
> & {
  answerableAskIds: ReadonlySet<string>;
  dismissableAskIds: ReadonlySet<string>;
  speakingMessageId?: string;
};

/**
 * The docked chat over the full-screen computer: the active thread's latest messages, scrollable,
 * with the one Composer portaled into its own slot beneath them. A drag handle resizes it and
 * flips it between the top and bottom edge; a toggle collapses it to just the composer row.
 */
export function ComputerDock({
  messages,
  messageProps,
}: {
  messages: readonly ThreadMessage[];
  messageProps: ComputerDockMessageProps;
}) {
  const dock = useComputerDock(COMPUTER_DOCK_MIN_HEIGHT);
  const dockRef = useDockClaim(true, "computer-overlay");
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const shown = messages.slice(-COMPUTER_DOCK_MESSAGE_COUNT);
  const lastMessageId = shown.at(-1)?.id;
  const { answerableAskIds, dismissableAskIds, speakingMessageId, ...viewProps } = messageProps;

  useEffect(() => {
    const list = listRef.current;
    if (!list || !stickToBottom.current) return;
    list.scrollTop = list.scrollHeight;
  }, [lastMessageId]);

  function onListScroll() {
    const list = listRef.current;
    if (!list) return;
    stickToBottom.current = transcriptIsNearEnd(list);
  }

  const edgeClass = dock.edge === "top" ? "top-0 border-b" : "bottom-0 border-t";
  const handleOrder = dock.edge === "top" ? "order-last" : "order-first";

  return (
    <div
      data-testid="computer-dock"
      className={`absolute inset-x-0 z-10 flex flex-col border-sidebar-border bg-card shadow-lg ${edgeClass}`}
      style={{ height: dock.collapsed ? undefined : `${dock.height}px` }}
    >
      <div className={`flex items-center justify-center gap-2 px-3 py-1 ${handleOrder}`}>
        {!dock.collapsed ? (
          <div className="relative flex w-full max-w-24 items-center justify-center">
            <hr
              data-testid="computer-dock-handle"
              {...dock.handleProps}
              aria-label={t`Resize the docked chat`}
              className="m-0 w-full cursor-row-resize touch-none self-stretch border-0 outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            />
            <GripHorizontal
              aria-hidden
              size={16}
              strokeWidth={1.8}
              className="pointer-events-none absolute text-muted-foreground"
            />
          </div>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute end-2 text-muted-foreground"
          aria-label={dock.collapsed ? t`Expand the docked chat` : t`Collapse the docked chat`}
          aria-pressed={dock.collapsed}
          onClick={() => dock.setCollapsed(!dock.collapsed)}
        >
          {dock.collapsed ? (
            <ChevronUp size={16} strokeWidth={1.8} />
          ) : (
            <ChevronDown size={16} strokeWidth={1.8} />
          )}
        </Button>
      </div>
      {!dock.collapsed ? (
        <div ref={listRef} onScroll={onListScroll} className="min-h-0 flex-1 overflow-y-auto px-3">
          {shown.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted-foreground">
              <Trans>No messages yet</Trans>
            </p>
          ) : (
            <div className="flex flex-col gap-3 py-2">
              {shown.map((message) => (
                <MessageView
                  key={message.id}
                  {...viewProps}
                  message={message}
                  canAnswer={answerableAskIds.has(message.id)}
                  canDismiss={dismissableAskIds.has(message.id)}
                  speaking={speakingMessageId === message.id}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
      <div data-testid="computer-dock-composer" className="shrink-0 border-t border-sidebar-border">
        <div ref={dockRef} />
      </div>
    </div>
  );
}
