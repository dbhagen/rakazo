import type { Prisma, PrismaClient } from "./client.js";

/** Non-revoked trusted webhook sources for a bot, newest first. */
export async function listTrustedWebhookSources(
  prisma: Pick<PrismaClient | Prisma.TransactionClient, "webhookTrustedSource">,
  { botId }: { botId: string },
) {
  return prisma.webhookTrustedSource.findMany({
    where: { botId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Trusts a source for a bot. Idempotent: calling it again for the same
 * (botId, sourceKey) while a non-revoked row already exists updates that
 * row's label instead of inserting a second one, which matters under the
 * partial unique index that allows only one active row per source.
 */
export async function trustWebhookSource(
  tx: Pick<PrismaClient | Prisma.TransactionClient, "webhookTrustedSource">,
  {
    botId,
    userId,
    spaceId,
    sourceKey,
    label,
  }: { botId: string; userId: string; spaceId: string; sourceKey: string; label: string },
) {
  const existing = await tx.webhookTrustedSource.findFirst({
    where: { botId, sourceKey, revokedAt: null },
  });
  if (existing) {
    return tx.webhookTrustedSource.update({
      where: { id: existing.id },
      data: { label },
    });
  }
  return tx.webhookTrustedSource.create({
    data: { botId, userId, spaceId, sourceKey, label },
  });
}

/** Revokes a trusted source. A no-op if it's already revoked or missing. */
export async function revokeTrustedWebhookSource(
  prisma: Pick<PrismaClient | Prisma.TransactionClient, "webhookTrustedSource">,
  { id, botId }: { id: string; botId: string },
) {
  await prisma.webhookTrustedSource.updateMany({
    where: { id, botId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** True when the given source has a non-revoked trust row for the bot. */
export async function isWebhookSourceTrusted(
  prisma: Pick<PrismaClient | Prisma.TransactionClient, "webhookTrustedSource">,
  { botId, sourceKey }: { botId: string; sourceKey: string },
): Promise<boolean> {
  const row = await prisma.webhookTrustedSource.findFirst({
    where: { botId, sourceKey, revokedAt: null },
    select: { id: true },
  });
  return row !== null;
}
