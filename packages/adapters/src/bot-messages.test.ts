import type { PrismaClient } from "@rakazo/db";
import { RunHistoryWriteError } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentBotMessageHop,
  loadBotMessageContext,
  messageBot,
  returnBotMessageOutcome,
} from "./bot-messages.js";
import type { ExecutorDeps } from "./executor-deps.js";

const run = {
  id: "run-1",
  spaceId: "workspace-1",
  threadId: "thread-sender",
  botId: "bot-sender",
  userId: "user-1",
  sourceMessageId: null as string | null,
};
const sender = { id: "bot-sender", name: "Researcher" };

function deps(
  options: {
    bots?: unknown[];
    hopBlocks?: unknown[];
    senderRunning?: boolean;
    alreadyDelivered?: unknown;
    targetArchived?: boolean;
    requesterArchived?: boolean;
    /** Simulate a unique (threadId, clientNonce) race after both retries miss. */
    uniqueConflictOnCommit?: boolean;
    transactionConflictOnce?: boolean;
    /** Target spaceId/space name reported by the in-transaction re-check. */
    targetSpaceId?: string;
    targetSpaceName?: string;
    /** Rows `crossSpaceCommunicationAllowed`'s raw query returns inside the transaction. */
    crossSpaceRows?: Array<{
      id: string;
      spaceId: string;
      crossSpaceCommunication: boolean;
      archivedAt: Date | null;
    }>;
  } = {},
) {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  const messageFindUnique = vi
    .fn()
    .mockImplementation(async (args: { where?: { threadId_clientNonce?: unknown } }) =>
      args?.where?.threadId_clientNonce
        ? (options.alreadyDelivered ?? null)
        : { blocks: options.hopBlocks ?? [] },
    );
  const tx = {
    // The thread-lock query and crossSpaceCommunicationAllowed's bots query share
    // this mock; tell them apart by the literal SQL fragment each one sends.
    $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings[0]?.includes("FROM bots")) return options.crossSpaceRows ?? [];
      return [{ id: "thread" }];
    }),
    run: {
      findFirst: vi
        .fn()
        .mockResolvedValue(options.senderRunning === false ? null : { id: "run-1" }),
      findUnique: vi.fn().mockResolvedValue({ status: "running" }),
      create: vi.fn().mockResolvedValue({ id: "run-2" }),
    },
    bot: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          options.targetArchived
            ? null
            : { id: "bot-target", spaceId: options.targetSpaceId ?? run.spaceId },
        ),
    },
    task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
    message: {
      findUnique: messageFindUnique,
      create: vi.fn().mockResolvedValue({ id: "message-1", seq: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    event: { create: vi.fn().mockResolvedValue({ seq: 7 }) },
    thread: { update: vi.fn().mockResolvedValue({}) },
  };
  let transactionAttempts = 0;
  const prisma = {
    bot: {
      findFirst: vi.fn().mockResolvedValue(options.requesterArchived ? null : { id: "bot-target" }),
      findMany: vi.fn().mockResolvedValue(
        options.bots ?? [
          {
            id: "bot-target",
            name: "Analyst",
            title: "",
            spaceId: run.spaceId,
            crossSpaceCommunication: true,
            space: { name: "Default" },
            thread: { id: "thread-target" },
          },
        ],
      ),
    },
    message: { findUnique: messageFindUnique, findMany: vi.fn().mockResolvedValue([]) },
    run: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => {
      transactionAttempts += 1;
      if (options.transactionConflictOnce && transactionAttempts === 1) {
        throw Object.assign(new Error("write conflict"), { code: "P2034" });
      }
      if (options.uniqueConflictOnCommit) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      return fn(tx);
    }),
  } as unknown as PrismaClient;
  return {
    deps: { prisma, events: { notify }, jobs: { enqueue } } as unknown as Pick<
      ExecutorDeps,
      "prisma" | "events" | "jobs"
    >,
    tx,
    enqueue,
    notify,
  };
}

describe("messaging another bot", () => {
  beforeEach(() => vi.stubEnv("BOT_MESSAGE_MAX_HOPS", undefined));
  afterEach(() => vi.unstubAllEnvs());

  it("delivers into the target's own chat without marking either thread unread", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "  chart the q3 numbers  ",
    });

    expect(sent).toMatchObject({ ok: true, botId: "bot-target", name: "Analyst" });
    expect(harness.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-target",
          threadId: "thread-target",
          prompt: expect.stringMatching(/not the user typing[\s\S]*untrusted peer content/),
        }),
      }),
    );
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-target",
          threadId: "thread-target",
          status: "queued",
          trigger: "bot_message",
        }),
      }),
    );
    expect(harness.notify).toHaveBeenCalledWith("thread-target", 7);
    expect(harness.notify).toHaveBeenCalledWith("thread-sender", 7);
    expect(harness.tx.message.create).toHaveBeenCalledTimes(2);
    expect(
      harness.tx.thread.update.mock.calls.filter(
        ([call]) => (call as { data?: { unread?: boolean } }).data?.unread,
      ),
    ).toHaveLength(0);
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it("marks a forced failure return unread on both sides", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "Could not complete the delegated request.",
      "status",
      { forceUnread: true },
    );

    const unreadWrites = harness.tx.thread.update.mock.calls.filter(
      ([call]) => (call as { data?: { unread?: boolean } }).data?.unread === true,
    );
    expect(unreadWrites).toHaveLength(2);
  });

  it("tells the sender to continue independent work", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "ping",
    });
    expect(sent.ok && sent.note).toContain("async");
    expect(sent.ok && sent.note).toContain("Continue independent work");
  });

  it("refuses a bot messaging itself", async () => {
    const harness = deps({
      bots: [
        {
          id: "bot-sender",
          name: "Researcher",
          title: "",
          spaceId: run.spaceId,
          crossSpaceCommunication: true,
          space: { name: "Default" },
          thread: { id: "thread-sender" },
        },
      ],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-sender",
      message: "hello",
    });
    expect(sent).toEqual({ ok: false, error: "a bot cannot message itself" });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("refuses an unknown target without starting a run", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-missing",
      message: "hello",
    });
    expect(sent).toEqual({ ok: false, error: "no bot found with that id or name" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("refuses an empty message", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "   ",
    });
    expect(sent).toEqual({ ok: false, error: "message is required" });
  });

  it("rejects an oversized message instead of silently truncating it", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "x".repeat(8_001),
    });
    expect(sent).toEqual({ ok: false, error: "message exceeds the 8000 character limit" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("does not deliver once the sending run is no longer active", async () => {
    const harness = deps({ senderRunning: false });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "hello",
    });
    expect(sent).toMatchObject({ ok: false });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("does not deliver from an attempt a newer claim superseded", async () => {
    const harness = deps();
    harness.tx.run.findUnique.mockResolvedValue({
      status: "running",
      leaseOwner: "worker-2",
      leaseFence: 2,
    });
    await expect(
      messageBot(
        { ...harness.deps, runLease: { runId: run.id, owner: "worker-1", fence: 1 } },
        run,
        sender,
        { bot_id: "bot-target", message: "hello" },
      ),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(harness.tx.message.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("stops a chain that has volleyed too many times", async () => {
    const harness = deps({
      hopBlocks: [
        { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "hi", hop: 6 },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "again" },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("allows a final result back through after the request hop limit", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "please finish",
          hop: 6,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "finished", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(true);
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          replyToMessageId: "message-request",
          blocks: expect.arrayContaining([expect.objectContaining({ intent: "result" })]),
        }),
      }),
    );
  });

  it("does not inherit a request reply link when messaging another bot", async () => {
    const harness = deps({
      bots: [
        {
          id: "bot-target",
          name: "Analyst",
          title: "",
          spaceId: run.spaceId,
          crossSpaceCommunication: true,
          space: { name: "Default" },
          thread: { id: "thread-target" },
        },
        {
          id: "bot-other",
          name: "Writer",
          title: "",
          spaceId: run.spaceId,
          crossSpaceCommunication: true,
          space: { name: "Default" },
          thread: { id: "thread-other" },
        },
      ],
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "check Gmail",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });

    await messageBot(harness.deps, { ...run, sourceMessageId: "message-source" }, sender, {
      bot_id: "bot-other",
      message: "unrelated update",
      intent: "fyi",
    });

    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ replyToMessageId: undefined }),
      }),
    );
  });

  it("does not inherit a request reply link for an FYI to the requester", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "check Gmail",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });

    await messageBot(harness.deps, { ...run, sourceMessageId: "message-source" }, sender, {
      bot_id: "bot-target",
      message: "unrelated update",
      intent: "fyi",
    });

    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ replyToMessageId: undefined }),
      }),
    );
  });

  it("does not exempt a terminal reply to another terminal reply", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "finished",
          hop: 6,
          intent: "result",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "acknowledged", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("does not let a result label bypass the hop limit toward an unrelated bot", async () => {
    const harness = deps({
      bots: [
        {
          id: "bot-target",
          name: "Analyst",
          title: "",
          spaceId: run.spaceId,
          crossSpaceCommunication: true,
          space: { name: "Default" },
          thread: { id: "thread-target" },
        },
        {
          id: "bot-other",
          name: "Writer",
          title: "",
          spaceId: run.spaceId,
          crossSpaceCommunication: true,
          space: { name: "Default" },
          thread: { id: "thread-other" },
        },
      ],
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "please finish",
          hop: 6,
          intent: "request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-other", message: "keep going", intent: "result" },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("keeps model-supplied status updates subject to the hop limit", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "please finish",
          hop: 6,
          intent: "request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "still working", intent: "status" },
    );
    expect(sent.ok).toBe(false);
  });

  it("raises the chain limit from BOT_MESSAGE_MAX_HOPS", async () => {
    vi.stubEnv("BOT_MESSAGE_MAX_HOPS", "10");
    const harness = deps({
      hopBlocks: [
        { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "hi", hop: 6 },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "again" },
    );
    expect(sent.ok).toBe(true);
  });

  it("keeps a person-started chain going", async () => {
    const harness = deps({
      hopBlocks: [
        { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "hi", hop: 1 },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "carry on" },
    );
    expect(sent.ok).toBe(true);
  });
});

describe("hop lookup", () => {
  it("treats a run a person started as the start of a chain", async () => {
    const prisma = { message: { findUnique: vi.fn() } } as unknown as PrismaClient;
    expect(await currentBotMessageHop(prisma, null)).toBe(0);
    expect(prisma.message.findUnique).not.toHaveBeenCalled();
  });

  it("reads the hop back off the message that woke the bot", async () => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            { kind: "text", text: "noise" },
            { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "x", hop: 3 },
          ],
        }),
      },
    } as unknown as PrismaClient;
    expect(await currentBotMessageHop(prisma, "message-1")).toBe(3);
  });

  it("requires the linked request to target the agent that sent the wake-up", async () => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "requester",
              fromBotName: "Requester",
              text: "work on this",
              intent: "result",
              returnToMessageId: "request-message",
            },
          ],
          replyTo: {
            id: "different-message",
            blocks: [
              {
                kind: "bot_message_sent",
                toBotId: "other-agent",
                toBotName: "Other agent",
                text: "work on this",
                intent: "request",
              },
            ],
          },
        }),
      },
    } as unknown as PrismaClient;

    await expect(loadBotMessageContext(prisma, "message-source")).resolves.toMatchObject({
      repliesToRequest: false,
    });
  });

  it.each([
    ["result", true],
    ["status", true],
    ["fyi", true],
    ["request", false],
    ["question", false],
    [undefined, false],
  ])("classifies a linked %s message as a returned answer: %s", async (intent, expected) => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "requester",
              fromBotName: "Requester",
              text: "work on this",
              intent,
              returnToMessageId: "return-echo",
            },
          ],
          replyTo: {
            id: "request-message",
            blocks: [
              {
                kind: "bot_message_sent",
                toBotId: "requester",
                toBotName: "Requester",
                text: "work on this",
                intent: "request",
              },
            ],
          },
        }),
      },
    } as unknown as PrismaClient;

    await expect(loadBotMessageContext(prisma, "message-source")).resolves.toMatchObject({
      repliesToRequest: expected,
    });
  });
});

describe("hardening", () => {
  it("does not deliver twice when the tool call is re-executed", async () => {
    const harness = deps({ alreadyDelivered: { id: "message-1" } });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });

    expect(sent).toMatchObject({ ok: true, replayed: true, botId: "bot-target" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("stamps the delivery so a retry can recognise it", async () => {
    const harness = deps();
    await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });
    expect(harness.tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientNonce: "bot-message:call-1" }),
      }),
    );
  });

  it("still delivers when the caller supplies no delivery key", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent.ok).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalled();
  });

  it("does not deliver to a bot archived while the message was being sent", async () => {
    const harness = deps({ targetArchived: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent).toMatchObject({ ok: false });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("treats a delivery-key unique conflict as a replay", async () => {
    const harness = deps({ uniqueConflictOnCommit: true });
    // After both retries miss and the loser hits P2002, the winner is visible.
    (harness.deps.prisma.message.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "message-winner",
    });

    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });

    expect(sent).toMatchObject({ ok: true, replayed: true, botId: "bot-target" });
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("retries a serialization conflict without dropping the delivery", async () => {
    const harness = deps({ transactionConflictOnce: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent.ok).toBe(true);
    expect(harness.deps.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });
});

describe("automatic outcome return", () => {
  it("routes a delegated run's final text back to its coordinator", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );
    expect(returned).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "bot_message" }) }),
    );
    expect(harness.tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["completed", "failed", "cancelled"] },
        }),
      }),
    );
    expect(harness.enqueue).toHaveBeenCalledOnce();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: run.id,
        status: { in: ["completed", "failed", "cancelled"] },
        botOutcomeReturnedAt: null,
      },
      data: { botOutcomeReturnedAt: expect.any(Date) },
    });
  });

  it("still returns a final result after an interim status update", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    vi.mocked(harness.deps.prisma.message.findMany).mockResolvedValue([
      {
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-target",
            toBotName: "Coordinator",
            text: "still looking",
            hop: 2,
            intent: "status",
          },
        ],
      },
    ] as never);

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });

  it("skips the automatic return when a result was already sent", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    vi.mocked(harness.deps.prisma.message.findMany).mockResolvedValue([
      {
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-target",
            toBotName: "Coordinator",
            text: "done",
            hop: 2,
            intent: "result",
          },
        ],
      },
    ] as never);

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalled();
  });

  it("counts the outcome as returned once the requesting bot is archived", async () => {
    const harness = deps({
      requesterArchived: true,
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.deps.prisma.bot.findFirst).toHaveBeenCalledWith({
      where: { id: "bot-target", userId: run.userId, archivedAt: null },
      select: { id: true },
    });
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: run.id,
        status: { in: ["completed", "failed", "cancelled"] },
        botOutcomeReturnedAt: null,
      },
      data: { botOutcomeReturnedAt: expect.any(Date) },
    });
  });
});

describe("cross-space messaging", () => {
  const senderBot = (crossSpaceCommunication: boolean) => ({
    id: "bot-sender",
    name: "Researcher",
    spaceId: run.spaceId,
    crossSpaceCommunication,
    space: { name: "Default" },
    thread: { id: "thread-sender" },
  });
  const crossSpaceTarget = (
    crossSpaceCommunication: boolean,
    overrides: Partial<Record<string, unknown>> = {},
  ) => ({
    id: "bot-target",
    name: "Analyst",
    spaceId: "workspace-2",
    crossSpaceCommunication,
    space: { name: "Other Space" },
    thread: { id: "thread-target" },
    ...overrides,
  });

  it("delivers to a cross-space target when both flags are on", async () => {
    const harness = deps({
      bots: [senderBot(true), crossSpaceTarget(true)],
      targetSpaceId: "workspace-2",
      crossSpaceRows: [
        { id: "bot-sender", spaceId: run.spaceId, crossSpaceCommunication: true, archivedAt: null },
        {
          id: "bot-target",
          spaceId: "workspace-2",
          crossSpaceCommunication: true,
          archivedAt: null,
        },
      ],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "cross-space ping",
    });
    expect(sent).toMatchObject({ ok: true, botId: "bot-target", name: "Analyst" });
    expect(sent.ok && sent.note).toContain("Other Space space");
    expect(harness.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ spaceId: "workspace-2" }) }),
    );
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ spaceId: "workspace-2" }) }),
    );
    expect(harness.tx.event.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ spaceId: "workspace-2" }) }),
    );
    expect(harness.tx.event.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ spaceId: run.spaceId }) }),
    );
  });

  it("refuses a cross-space target when the sender's flag is off", async () => {
    const harness = deps({ bots: [senderBot(false), crossSpaceTarget(true)] });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "cross-space ping",
    });
    expect(sent).toEqual({
      ok: false,
      error:
        "Analyst is in another space and cross-space bot communication is disabled for one of the bots",
    });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("refuses a cross-space target when the target's flag is off", async () => {
    const harness = deps({ bots: [senderBot(true), crossSpaceTarget(false)] });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "cross-space ping",
    });
    expect(sent).toEqual({
      ok: false,
      error:
        "Analyst is in another space and cross-space bot communication is disabled for one of the bots",
    });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("refuses delivery when the flag flips between resolve and commit", async () => {
    const harness = deps({
      bots: [senderBot(true), crossSpaceTarget(true)],
      targetSpaceId: "workspace-2",
      crossSpaceRows: [
        { id: "bot-sender", spaceId: run.spaceId, crossSpaceCommunication: true, archivedAt: null },
        {
          id: "bot-target",
          spaceId: "workspace-2",
          crossSpaceCommunication: false,
          archivedAt: null,
        },
      ],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "cross-space ping",
    });
    expect(sent).toEqual({ ok: false, error: "cross-space bot communication is disabled" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("prefers a same-space bot over a cross-space bot sharing its name", async () => {
    const harness = deps({
      bots: [
        senderBot(true),
        {
          id: "bot-same",
          name: "Analyst",
          spaceId: run.spaceId,
          crossSpaceCommunication: true,
          space: { name: "Default" },
          thread: { id: "thread-same" },
        },
        crossSpaceTarget(true),
      ],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      confirm_name: "Analyst",
      message: "hello",
    });
    expect(sent).toMatchObject({ ok: true, botId: "bot-same" });
  });

  it("refuses an ambiguous name shared by two cross-space bots with none in this space", async () => {
    const harness = deps({
      bots: [
        senderBot(true),
        crossSpaceTarget(true),
        {
          id: "bot-target-2",
          name: "Analyst",
          spaceId: "workspace-3",
          crossSpaceCommunication: true,
          space: { name: "Third Space" },
          thread: { id: "thread-target-2" },
        },
      ],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      confirm_name: "Analyst",
      message: "hello",
    });
    expect(sent).toEqual({
      ok: false,
      error: "more than one bot is named Analyst in other spaces; pass bot_id",
    });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });
});

describe("returnBotMessageOutcome across spaces", () => {
  it("delivers an outcome to a requester in another space", async () => {
    const harness = deps({
      bots: [
        {
          id: "bot-sender",
          name: "Researcher",
          spaceId: run.spaceId,
          crossSpaceCommunication: true,
          space: { name: "Default" },
          thread: { id: "thread-sender" },
        },
        {
          id: "bot-target",
          name: "Coordinator",
          spaceId: "workspace-2",
          crossSpaceCommunication: true,
          space: { name: "Other Space" },
          thread: { id: "thread-target" },
        },
      ],
      targetSpaceId: "workspace-2",
      crossSpaceRows: [
        { id: "bot-sender", spaceId: run.spaceId, crossSpaceCommunication: true, archivedAt: null },
        {
          id: "bot-target",
          spaceId: "workspace-2",
          crossSpaceCommunication: true,
          archivedAt: null,
        },
      ],
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ spaceId: "workspace-2" }) }),
    );
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });
});
