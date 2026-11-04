import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

// Offline boundary: a fake Prisma client drives the real router handlers and the real
// repos.getBot ownership check, same as bot-secrets-router.test.ts.

type Row = Record<string, unknown>;

function matches(row: Row, where: Row = {}) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function setup() {
  const now = new Date("2026-09-01T00:00:00.000Z");
  const bots: Row[] = [
    { id: "bot-1", userId: "user-1", spaceId: "space-1", archivedAt: null },
    { id: "bot-other", userId: "user-2", spaceId: "space-1", archivedAt: null },
  ];
  const sources: Row[] = [
    {
      id: "source-1",
      botId: "bot-1",
      sourceKey: "github:acme/repo",
      label: "acme/repo",
      createdAt: now,
      revokedAt: null,
    },
    {
      id: "source-2",
      botId: "bot-1",
      sourceKey: "github:acme/other",
      label: "acme/other",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      revokedAt: null,
    },
    {
      id: "source-other-bot",
      botId: "bot-other",
      sourceKey: "github:acme/x",
      label: "acme/x",
      createdAt: now,
      revokedAt: null,
    },
  ];
  const prisma = {
    bot: {
      findFirst: async (args: { where: Row }) => {
        const bot = bots.find((entry) => matches(entry, args.where));
        return bot ? { ...bot, thread: null, computer: null } : null;
      },
    },
    webhookTrustedSource: {
      findMany: async (args: { where: Row; orderBy?: unknown }) => {
        expect(args.orderBy).toEqual({ createdAt: "desc" });
        return sources
          .filter((row) => matches(row, args.where))
          .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
      },
      updateMany: async (args: { where: Row; data: Row }) => {
        const matched = sources.filter((row) => matches(row, args.where));
        for (const row of matched) Object.assign(row, args.data);
        return { count: matched.length };
      },
    },
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  const client = (userId: string, spaceId = "space-1") =>
    createRouterClient(createRouter(deps), {
      context: {
        actor: {
          userId,
          spaceId,
          email: `${userId}@rakazo.test`,
          isDeploymentOwner: false,
        } satisfies Actor,
      } as never,
    }).bots.trustedWebhookSources;
  return { sources, client };
}

describe("bots.trustedWebhookSources router", () => {
  it("lists a bot's non-revoked trusted sources, newest first, for its owner", async () => {
    const { client } = setup();
    await expect(client("user-1").list({ botId: "bot-1" })).resolves.toEqual([
      expect.objectContaining({ id: "source-1", label: "acme/repo" }),
      expect.objectContaining({ id: "source-2", label: "acme/other" }),
    ]);
  });

  it("rejects a non-owner's list request", async () => {
    const { client } = setup();
    await expect(client("user-2").list({ botId: "bot-1" })).rejects.toBeTruthy();
  });

  it("revokes a source and returns the updated list", async () => {
    const { sources, client } = setup();
    await expect(client("user-1").revoke({ botId: "bot-1", id: "source-1" })).resolves.toEqual([
      expect.objectContaining({ id: "source-2" }),
    ]);
    expect(sources.find((row) => row.id === "source-1")?.revokedAt).toEqual(expect.any(Date));
  });

  it("rejects a non-owner's revoke request", async () => {
    const { sources, client } = setup();
    await expect(client("user-2").revoke({ botId: "bot-1", id: "source-1" })).rejects.toBeTruthy();
    expect(sources.find((row) => row.id === "source-1")?.revokedAt).toBeNull();
  });

  it("refuses to revoke a row that belongs to another bot", async () => {
    const { sources, client } = setup();
    await expect(
      client("user-1").revoke({ botId: "bot-1", id: "source-other-bot" }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "source-1" }),
      expect.objectContaining({ id: "source-2" }),
    ]);
    expect(sources.find((row) => row.id === "source-other-bot")?.revokedAt).toBeNull();
  });
});
