import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { runAsSystem, runAsTenant } from "./row-security.js";
import {
  isWebhookSourceTrusted,
  listTrustedWebhookSources,
  revokeTrustedWebhookSource,
  trustWebhookSource,
} from "./webhook-trusted-sources.js";

// Needs DATABASE_URL as the runtime login and DATABASE_MIGRATION_URL as the
// owner, as `pnpm test:integration` provides after `pnpm db:migrate`.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

describePostgres("webhook trusted sources (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `wts-org-${suffix}`;
  const tenants = ["a", "b"].map((name) => ({
    name,
    userId: `wts-user-${name}-${suffix}`,
    spaceId: `wts-space-${name}-${suffix}`,
    botId: `wts-bot-${name}-${suffix}`,
  }));
  const [a, b] = tenants as [(typeof tenants)[0], (typeof tenants)[0]];
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let db: PrismaClient;

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!, { poolMax: 4 });
    db = app.prisma;
    const o = owner.prisma;
    // Fixtures span both tenants, so they're written as the system.
    await runAsSystem("webhook trusted sources test fixture", async () => {
      await o.organization.create({
        data: { id: organizationId, name: "WTS", slug: organizationId, createdAt: new Date() },
      });
      for (const t of tenants) {
        await o.user.create({
          data: {
            id: t.userId,
            name: t.name,
            email: `${t.userId}@rakazo.test`,
            emailVerified: true,
          },
        });
        await o.space.create({ data: { id: t.spaceId, organizationId, name: t.name } });
        await o.bot.create({
          data: { id: t.botId, spaceId: t.spaceId, userId: t.userId, name: t.name, color: "#000" },
        });
        await o.member.create({
          data: {
            id: `${t.userId}-member`,
            organizationId,
            userId: t.userId,
            role: "owner",
            createdAt: new Date(),
          },
        });
        await o.spaceMember.create({
          data: {
            id: `${t.userId}-space-member`,
            spaceId: t.spaceId,
            userId: t.userId,
            organizationId,
            role: "owner",
            createdAt: new Date(),
          },
        });
      }
    });
  });

  afterAll(async () => {
    if (!owner) return;
    await runAsSystem("webhook trusted sources test cleanup", async () => {
      await owner.prisma.organization.deleteMany({ where: { id: organizationId } });
      await owner.prisma.user.deleteMany({ where: { id: { in: tenants.map((t) => t.userId) } } });
    });
    for (const handle of [owner, app]) {
      await handle.prisma.$disconnect();
      await handle.pool.end();
    }
  });

  it("applies the migration and creates the table", async () => {
    const rows = await owner.prisma.$queryRaw<Array<{ to_regclass: string | null }>>`
      SELECT to_regclass('public.webhook_trusted_sources')::text AS to_regclass`;
    expect(rows[0]?.to_regclass).toBe("webhook_trusted_sources");
  });

  it("requires the bypass key on the system policy, like every other table", async () => {
    const policies = await owner.prisma.$queryRaw<Array<{ policyname: string; qual: string }>>`
      SELECT policyname, qual FROM pg_policies WHERE tablename = 'webhook_trusted_sources'`;
    const system = policies.find((row) => row.policyname === "webhook_trusted_sources_system");
    expect(system?.qual).toContain("app_rls_bypass()");
  });

  it("trusts a source idempotently and lists it newest first", async () => {
    await runAsTenant(a, () =>
      trustWebhookSource(db, {
        botId: a.botId,
        userId: a.userId,
        spaceId: a.spaceId,
        sourceKey: "github:acme/repo",
        label: "acme/repo",
      }),
    );
    // Trusting the same source again must not create a second active row.
    await runAsTenant(a, () =>
      trustWebhookSource(db, {
        botId: a.botId,
        userId: a.userId,
        spaceId: a.spaceId,
        sourceKey: "github:acme/repo",
        label: "acme/repo (renamed)",
      }),
    );
    const rows = await runAsTenant(a, () => listTrustedWebhookSources(db, { botId: a.botId }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("acme/repo (renamed)");
    expect(
      await runAsTenant(a, () =>
        isWebhookSourceTrusted(db, { botId: a.botId, sourceKey: "github:acme/repo" }),
      ),
    ).toBe(true);
  });

  it("revokes then allows re-trusting the same source", async () => {
    const sourceKey = `generic:webhook-${suffix}`;
    await runAsTenant(a, () =>
      trustWebhookSource(db, {
        botId: a.botId,
        userId: a.userId,
        spaceId: a.spaceId,
        sourceKey,
        label: "first",
      }),
    );
    const target = (
      await runAsTenant(a, () => listTrustedWebhookSources(db, { botId: a.botId }))
    ).find((row) => row.sourceKey === sourceKey);
    expect(target).toBeDefined();

    await runAsTenant(a, () => revokeTrustedWebhookSource(db, { id: target!.id, botId: a.botId }));
    expect(
      await runAsTenant(a, () => isWebhookSourceTrusted(db, { botId: a.botId, sourceKey })),
    ).toBe(false);

    // Revoked, so the active-row-only unique index allows a fresh trust row.
    await runAsTenant(a, () =>
      trustWebhookSource(db, {
        botId: a.botId,
        userId: a.userId,
        spaceId: a.spaceId,
        sourceKey,
        label: "second",
      }),
    );
    expect(
      await runAsTenant(a, () => isWebhookSourceTrusted(db, { botId: a.botId, sourceKey })),
    ).toBe(true);
    const active = (
      await runAsTenant(a, () => listTrustedWebhookSources(db, { botId: a.botId }))
    ).filter((row) => row.sourceKey === sourceKey);
    expect(active).toHaveLength(1);
    expect(active[0]?.label).toBe("second");
  });

  it("blocks a tenant of another space from reading or inserting rows", async () => {
    const sourceKey = `isolation:${suffix}`;
    await runAsTenant(a, () =>
      trustWebhookSource(db, {
        botId: a.botId,
        userId: a.userId,
        spaceId: a.spaceId,
        sourceKey,
        label: "space a",
      }),
    );
    const seenByB = await runAsTenant(b, () => listTrustedWebhookSources(db, { botId: a.botId }));
    expect(seenByB).toEqual([]);
    expect(
      await runAsTenant(b, () => isWebhookSourceTrusted(db, { botId: a.botId, sourceKey })),
    ).toBe(false);
    await expect(
      runAsTenant(b, () =>
        db.webhookTrustedSource.create({
          data: {
            botId: a.botId,
            userId: b.userId,
            spaceId: a.spaceId,
            sourceKey: `${sourceKey}-hostile`,
            label: "hostile",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    const seenBySystem = await runAsSystem("webhook trusted sources test", () =>
      listTrustedWebhookSources(db, { botId: a.botId }),
    );
    expect(seenBySystem.some((row) => row.sourceKey === sourceKey)).toBe(true);
  });
});
