import type { PrismaClient } from "@rakazo/db";
import { createDb, drainUnscopedDatabaseAccess, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messageBot, returnBotMessageOutcome } from "./bot-messages.js";
import type { ExecutorDeps } from "./executor-deps.js";

// Needs DATABASE_URL as the runtime login and DATABASE_MIGRATION_URL as the
// owner, with row-level security migrated and enforced, as `pnpm test:integration`
// provides after `pnpm db:migrate`.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

describePostgres("messageBot across Spaces (PostgreSQL contract)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `xspace-org-${suffix}`;
  const userId = `xspace-user-${suffix}`;
  const otherUserId = `xspace-other-user-${suffix}`;
  const spaceAId = `xspace-space-a-${suffix}`;
  const spaceBId = `xspace-space-b-${suffix}`;
  const botSAId = `xspace-bot-sa-${suffix}`;
  const botSBId = `xspace-bot-sb-${suffix}`;
  const otherBotId = `xspace-bot-other-${suffix}`;
  const threadSAId = `xspace-thread-sa-${suffix}`;
  const threadSBId = `xspace-thread-sb-${suffix}`;
  const otherThreadId = `xspace-thread-other-${suffix}`;

  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let db: PrismaClient;

  const makeRun = async (opts: {
    id: string;
    spaceId: string;
    botId: string;
    threadId: string;
    taskId: string;
    status?: string;
    sourceMessageId?: string | null;
  }) => {
    await owner.prisma.task.create({
      data: {
        id: opts.taskId,
        spaceId: opts.spaceId,
        botId: opts.botId,
        threadId: opts.threadId,
        userId,
        prompt: "p",
        status: "queued",
      },
    });
    await owner.prisma.run.create({
      data: {
        id: opts.id,
        spaceId: opts.spaceId,
        botId: opts.botId,
        threadId: opts.threadId,
        taskId: opts.taskId,
        userId,
        status: opts.status ?? "running",
        trigger: "created",
        sourceMessageId: opts.sourceMessageId ?? null,
      },
    });
    // Fixture setup connects as the migration owner, which bypasses row-level
    // security outright; the "unscoped access" report is for the runtime login.
    drainUnscopedDatabaseAccess();
  };

  const depsFor = (): Pick<ExecutorDeps, "prisma" | "events" | "jobs"> => ({
    prisma: db,
    events: { notify: async () => undefined } as unknown as ExecutorDeps["events"],
    jobs: { enqueue: async () => undefined } as unknown as ExecutorDeps["jobs"],
  });

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!, { poolMax: 4 });
    db = app.prisma;
    const o = owner.prisma;
    await o.organization.create({
      data: { id: organizationId, name: "XSpace", slug: organizationId, createdAt: new Date() },
    });
    await o.user.create({
      data: { id: userId, name: "Owner", email: `${userId}@rakazo.test`, emailVerified: true },
    });
    await o.user.create({
      data: {
        id: otherUserId,
        name: "Someone Else",
        email: `${otherUserId}@rakazo.test`,
        emailVerified: true,
      },
    });
    await o.space.create({ data: { id: spaceAId, organizationId, name: "A" } });
    await o.space.create({ data: { id: spaceBId, organizationId, name: "B" } });
    await o.bot.create({
      data: {
        id: botSAId,
        spaceId: spaceAId,
        userId,
        name: "SA",
        color: "#000",
        crossSpaceCommunication: true,
      },
    });
    await o.bot.create({
      data: {
        id: botSBId,
        spaceId: spaceBId,
        userId,
        name: "SB",
        color: "#000",
        crossSpaceCommunication: true,
      },
    });
    await o.bot.create({
      data: {
        id: otherBotId,
        spaceId: spaceBId,
        userId: otherUserId,
        name: "Intruder",
        color: "#000",
        crossSpaceCommunication: true,
      },
    });
    await o.thread.create({
      data: { id: threadSAId, spaceId: spaceAId, userId, botId: botSAId },
    });
    await o.thread.create({
      data: { id: threadSBId, spaceId: spaceBId, userId, botId: botSBId },
    });
    await o.thread.create({
      data: { id: otherThreadId, spaceId: spaceBId, userId: otherUserId, botId: otherBotId },
    });
    drainUnscopedDatabaseAccess();
  });

  afterAll(async () => {
    if (!owner) return;
    await owner.prisma.organization.deleteMany({ where: { id: organizationId } });
    await owner.prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    for (const handle of [owner, app]) {
      await handle.prisma.$disconnect();
      await handle.pool.end();
    }
  });

  it("delivers a request from SA to SB, then SB's result back to SA", async () => {
    const runAId = `xspace-run-a-${suffix}`;
    await makeRun({
      id: runAId,
      spaceId: spaceAId,
      botId: botSAId,
      threadId: threadSAId,
      taskId: `xspace-task-a-${suffix}`,
    });

    const sent = await runAsTenant({ spaceId: spaceAId, userId }, () =>
      messageBot(
        depsFor(),
        { id: runAId, spaceId: spaceAId, threadId: threadSAId, botId: botSAId, userId },
        { id: botSAId, name: "SA" },
        { confirm_name: "SB", message: "please look into this" },
      ),
    );
    expect(sent).toMatchObject({ ok: true, botId: botSBId, name: "SB" });

    // B got a task, run and inbound message with spaceId B.
    const inboundRun = await runAsSystem("test setup", () =>
      db.run.findFirst({
        where: { botId: botSBId, trigger: "bot_message" },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(inboundRun).toMatchObject({ spaceId: spaceBId, botId: botSBId, status: "queued" });
    const inboundTask = await runAsSystem("test setup", () =>
      db.task.findUnique({ where: { id: inboundRun!.taskId } }),
    );
    expect(inboundTask).toMatchObject({ spaceId: spaceBId });
    const inboundMessage = await runAsTenant({ spaceId: spaceBId, userId }, () =>
      db.message.findUnique({ where: { id: inboundRun!.sourceMessageId! } }),
    );
    expect(inboundMessage).toMatchObject({ threadId: threadSBId, role: "user" });

    // A gets the outbound echo.
    const outboundEcho = await runAsTenant({ spaceId: spaceAId, userId }, () =>
      db.message.findFirst({ where: { threadId: threadSAId, role: "bot" } }),
    );
    expect(outboundEcho).toBeTruthy();

    // SB's run replies with intent "result" to SA.
    await runAsSystem("test setup", () =>
      db.run.update({ where: { id: inboundRun!.id }, data: { status: "completed" } }),
    );
    const returned = await runAsTenant({ spaceId: spaceBId, userId }, () =>
      returnBotMessageOutcome(
        depsFor(),
        {
          id: inboundRun!.id,
          spaceId: spaceBId,
          threadId: threadSBId,
          botId: botSBId,
          userId,
          sourceMessageId: inboundRun!.sourceMessageId,
        },
        { id: botSBId, name: "SB" },
        "The answer is 42.",
      ),
    );
    expect(returned).toBe(true);

    const resultMessage = await runAsTenant({ spaceId: spaceAId, userId }, () =>
      db.message.findFirst({
        where: { threadId: threadSAId, role: "user" },
        orderBy: { seq: "desc" },
      }),
    );
    expect(resultMessage).toBeTruthy();
    const blocks = resultMessage!.blocks as Array<Record<string, unknown>>;
    expect(blocks.some((block) => block.kind === "bot_message_received")).toBe(true);
  });

  it("refuses delivery when the target's cross-space flag is off", async () => {
    const runAId = `xspace-run-a-off-${suffix}`;
    await makeRun({
      id: runAId,
      spaceId: spaceAId,
      botId: botSAId,
      threadId: threadSAId,
      taskId: `xspace-task-a-off-${suffix}`,
    });
    await owner.prisma.bot.update({
      where: { id: botSBId },
      data: { crossSpaceCommunication: false },
    });
    try {
      const runCountBefore = await owner.prisma.run.count({ where: { botId: botSBId } });
      const sent = await runAsTenant({ spaceId: spaceAId, userId }, () =>
        messageBot(
          depsFor(),
          { id: runAId, spaceId: spaceAId, threadId: threadSAId, botId: botSAId, userId },
          { id: botSAId, name: "SA" },
          { confirm_name: "SB", message: "please look into this" },
        ),
      );
      expect(sent).toEqual({
        ok: false,
        error:
          "SB is in another space and cross-space bot communication is disabled for one of the bots",
      });
      const runCountAfter = await owner.prisma.run.count({ where: { botId: botSBId } });
      expect(runCountAfter).toBe(runCountBefore);
    } finally {
      await owner.prisma.bot.update({
        where: { id: botSBId },
        data: { crossSpaceCommunication: true },
      });
      drainUnscopedDatabaseAccess();
    }
  });

  it("never resolves a bot owned by a different user", async () => {
    const runAId = `xspace-run-a-intruder-${suffix}`;
    await makeRun({
      id: runAId,
      spaceId: spaceAId,
      botId: botSAId,
      threadId: threadSAId,
      taskId: `xspace-task-a-intruder-${suffix}`,
    });
    const sent = await runAsTenant({ spaceId: spaceAId, userId }, () =>
      messageBot(
        depsFor(),
        { id: runAId, spaceId: spaceAId, threadId: threadSAId, botId: botSAId, userId },
        { id: botSAId, name: "SA" },
        { confirm_name: "Intruder", message: "hello" },
      ),
    );
    expect(sent).toEqual({ ok: false, error: "no bot found with that id or name" });
  });
});
