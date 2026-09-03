-- AlterTable
ALTER TABLE "mux_live_session"
ADD COLUMN     "sharedSessionCode" TEXT,
ADD COLUMN     "sharedSessionHostToken" TEXT,
ADD COLUMN     "sharedSessionId" TEXT;

-- Backfill existing rows so the new required fields can be enforced safely.
UPDATE "mux_live_session"
SET
  "sharedSessionId" = COALESCE("sharedSessionId", 'mux-shared-' || "id"),
  "sharedSessionHostToken" = COALESCE(
    "sharedSessionHostToken",
    md5("id" || clock_timestamp()::text || random()::text)
  ),
  "sharedSessionCode" = COALESCE(
    "sharedSessionCode",
    'SAL-' || upper(substr(md5("id" || clock_timestamp()::text || random()::text), 1, 6))
  )
WHERE
  "sharedSessionId" IS NULL
  OR "sharedSessionHostToken" IS NULL
  OR "sharedSessionCode" IS NULL;

-- AlterTable
ALTER TABLE "mux_live_session"
ALTER COLUMN "sharedSessionCode" SET NOT NULL,
ALTER COLUMN "sharedSessionHostToken" SET NOT NULL,
ALTER COLUMN "sharedSessionId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "mux_live_session_sharedSessionId_key" ON "mux_live_session"("sharedSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "mux_live_session_sharedSessionCode_key" ON "mux_live_session"("sharedSessionCode");
