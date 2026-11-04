import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import { Spinner } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { createPopOutClient } from "../lib/computer-pop-out-channel";
import {
  embeddableScreenUrl,
  screenFrameError,
  screenFrameMessage,
  screenIframeSandbox,
} from "../lib/computer-screen";
import { createSpaceRpc, selectedSpaceId } from "../lib/rpc";
import { isThreadSnapshotEvent, reduceThreadSnapshot } from "../lib/thread-events";
import { Composer } from "./shell/composer";
import { ComputerDock } from "./shell/computer-dock";

/**
 * A single bot's computer and chat in their own window, handed over from the main one through
 * `computer-pop-out-channel.ts`. Deliberately smaller than Shell's: this is one bot, one thread,
 * with no sidebar, routines, settings or multi-bot composer features. It builds its own thread
 * read + subscribe loop from the plainest `rpc.threads` calls rather than reusing `useThreadSync`,
 * which is wired through Shell's roster/composer state; and its own small screen hook rather than
 * `use-computer.tsx`'s, which already carries the reconnect/probe machinery the main window's
 * screen needs and isn't worth risking for a second, simpler caller. See the function doc below.
 */
export function ComputerPopOutPage() {
  const { botId } = useParams<{ botId: string }>();
  const [rpc] = useState(() => createSpaceRpc(selectedSpaceId()));
  const [returned, setReturned] = useState(false);
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const snapshotRef = useRef<ThreadSnapshot | null>(null);
  snapshotRef.current = snapshot;

  useEffect(() => {
    if (!botId) return;
    const client = createPopOutClient(botId, () => {
      // The main window wants the screen back. Closing is the common case; browsers that block a
      // script-closed tab leave a visible fallback instead of a window with nothing left to do.
      window.close();
      setReturned(true);
    });
    return () => client.close();
  }, [botId]);

  useEffect(() => {
    if (!botId || returned) return;
    let cancelled = false;
    const abort = new AbortController();
    void (async () => {
      try {
        const snap = await rpc.threads.get({ botId }, { signal: abort.signal });
        if (cancelled) return;
        setSnapshot(snap);
        const stream = await rpc.threads.subscribe(
          { botId, cursor: snap.cursor },
          { signal: abort.signal },
        );
        for await (const event of stream) {
          if (cancelled) break;
          if (isThreadSnapshotEvent(event))
            setSnapshot((current) => reduceThreadSnapshot(current, event));
        }
      } catch {
        // A dropped subscription just stops updating the transcript; the pop-out stays usable.
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [botId, rpc, returned]);

  const screen = usePopOutComputerScreen(rpc, returned ? undefined : botId);

  async function refresh() {
    if (!botId) return;
    const snap = await rpc.threads.get({ botId });
    setSnapshot(snap);
  }

  async function send(text: string): Promise<boolean> {
    if (!botId || !text.trim()) return false;
    await rpc.threads.send({ botId, clientNonce: newClientId(), text });
    await refresh().catch(() => undefined);
    return true;
  }

  if (!botId) return <PageLoading />;
  if (returned) {
    return (
      <div className="grid h-full place-items-center bg-background px-6 text-center text-sm text-muted-foreground">
        <Trans>Returned to the main window</Trans>
      </div>
    );
  }
  if (!snapshot) return <PageLoading />;

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="relative min-h-0 flex-1">
        {screen.embeddedScreenUrl ? (
          <iframe
            key={screen.frameKey}
            title={t`Bot screen`}
            ref={screen.setFrame}
            src={screen.embeddedScreenUrl}
            sandbox={screenIframeSandbox(screen.embeddedScreenUrl)}
            className="h-full w-full border-0 bg-black"
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground/80">
            {screen.error ?? <Spinner aria-hidden className="size-5 motion-reduce:animate-none" />}
          </div>
        )}
        <ComputerDock
          messages={snapshot.messages}
          messageProps={{
            artifactTarget: { botId },
            answerableAskIds: new Set<string>(),
            dismissableAskIds: new Set<string>(),
            onAnswer: async (message, text, fields, dismiss) => {
              await rpc.threads.answer({
                botId,
                runId: message.runId ?? "",
                messageId: message.id,
                answer: text,
                ...(fields ? { fields } : {}),
                ...(dismiss ? { dismiss: true as const } : {}),
              });
              await refresh().catch(() => undefined);
            },
            onOpenBot: () => {},
            onOpenPeerMessages: () => {},
            peerBot: () => undefined,
            memberName: () => undefined,
            onJumpToMessage: () => {},
            onRefresh: refresh,
            onBotChanged: async () => {},
            onAddRoutine: () => {},
            voiceReady: false,
            onSpeak: () => {},
            onOpenComputer: () => {},
            rpc,
            showToolActivity: true,
            onReply: () => {},
            onMarkUnread: () => {},
            onReact: async (message: ThreadMessage, reaction) => {
              await rpc.threads.react({
                botId,
                messageId: message.id,
                reaction,
                clientNonce: newClientId(),
              });
              await refresh().catch(() => undefined);
            },
          }}
        />
      </div>
      <PopOutComposer botId={botId} onSend={send} running={Boolean(snapshot.run)} />
    </div>
  );
}

function PopOutComposer({
  botId,
  onSend,
  running,
}: {
  botId: string;
  onSend: (text: string) => Promise<boolean>;
  running: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <Composer
      draftKey={`computer-pop-out:${botId}`}
      enterToSend={false}
      running={running}
      pendingAttachments={[]}
      attachmentNotice={null}
      sendError={null}
      onOpenModels={() => {}}
      onOpenConnections={() => {}}
      runError={null}
      runErrorId={null}
      onRunErrorPresented={() => {}}
      onDismissError={() => {}}
      sending={false}
      fileInputRef={fileInputRef}
      onAttachmentPick={() => false}
      onRemoveAttachment={() => {}}
      onSend={async (text) => onSend(text)}
      onStop={async () => {}}
      artifactTarget={{ botId }}
    />
  );
}

/**
 * A single-bot screen hook for the pop-out: fetch (booting and taking control if needed), one
 * reconnect on a dropped frame, and release on close. Deliberately not shared with
 * `use-computer.tsx`'s `useComputerState`/`useComputerControls` — those already carry the
 * multi-bot cache, Wuying one-time-code handling and bounded reconnect budget the main window's
 * screen needs, and extracting a shared subset mid-feature risked changing Shell's screen
 * lifecycle, which the task called out as something to stop and report on rather than force.
 */
function usePopOutComputerScreen(
  rpc: ReturnType<typeof createSpaceRpc>,
  botId: string | undefined,
) {
  const { t } = useLingui();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const reconnected = useRef(false);

  useEffect(() => {
    setUrl(null);
    setError(null);
    reconnected.current = false;
    if (!botId) return;
    let cancelled = false;
    void (async () => {
      try {
        let status: ComputerStatus = await rpc.computer.status({ botId });
        if (status.state !== "running") status = await rpc.computer.boot({ botId });
        if (cancelled) return;
        if (status.controlHolder !== "user" || status.controlBotId !== botId) {
          await rpc.computer.takeover({ botId });
        }
        if (cancelled) return;
        const screen = await rpc.computer.screenUrl({ botId });
        if (cancelled) return;
        setUrl(screen.url);
      } catch (loadError) {
        if (!cancelled)
          setError(
            loadError instanceof Error
              ? loadError.message
              : t`Could not connect to the computer screen`,
          );
      }
    })();
    const release = () => void rpc.computer.release({ botId }).catch(() => undefined);
    window.addEventListener("pagehide", release);
    window.addEventListener("beforeunload", release);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", release);
      window.removeEventListener("beforeunload", release);
    };
    // `t` is re-created each render by useLingui and is only used inside the async callback above.
  }, [botId, rpc]);

  useEffect(() => {
    if (!frame || !botId) return;
    const fallback = t`Could not connect to the computer screen`;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const message = screenFrameMessage(event.data);
      if (!message) return;
      const frameError = screenFrameError(message, fallback);
      if (!frameError) return;
      if (!reconnected.current) {
        // One reconnect, as a fresh frame rather than a bounded, state-machine-driven retry.
        reconnected.current = true;
        void rpc.computer
          .screenUrl({ botId })
          .then((screen) => {
            setUrl(screen.url);
            setFrameKey((key) => key + 1);
          })
          .catch(() => setError(frameError));
        return;
      }
      setError(frameError);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame, botId, rpc]);

  return {
    embeddedScreenUrl: embeddableScreenUrl(url),
    error,
    setFrame,
    frameKey,
  };
}
