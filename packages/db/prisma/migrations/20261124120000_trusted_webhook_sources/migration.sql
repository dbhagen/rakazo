-- Additive: the previous release never reads these columns or this table.
ALTER TABLE "bots" ADD COLUMN "trustWebhookSources" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "runs" ADD COLUMN "webhookSource" JSONB;

CREATE TABLE "webhook_trusted_sources" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "webhook_trusted_sources_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_trusted_sources_botId_revokedAt_idx" ON "webhook_trusted_sources"("botId", "revokedAt");

-- Prisma can't express a partial unique index in the schema: at most one
-- non-revoked row per (botId, sourceKey). Hand-written here.
CREATE UNIQUE INDEX "webhook_trusted_sources_botId_sourceKey_active_key" ON "webhook_trusted_sources"("botId", "sourceKey") WHERE "revokedAt" IS NULL;

ALTER TABLE "webhook_trusted_sources" ADD CONSTRAINT "webhook_trusted_sources_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhook_trusted_sources" ADD CONSTRAINT "webhook_trusted_sources_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same policies as computer_runs: a tenant reaches only its own space's rows.
ALTER TABLE "webhook_trusted_sources" ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_trusted_sources_tenant ON "webhook_trusted_sources"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY webhook_trusted_sources_system ON "webhook_trusted_sources"
  USING (current_setting('app.rls_bypass', true) = 'on');
