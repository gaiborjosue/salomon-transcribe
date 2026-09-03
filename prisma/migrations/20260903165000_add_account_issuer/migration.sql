-- Better Auth 1.7 requires every account identity to be scoped by issuer.
-- This application only supports email/password credential accounts.
ALTER TABLE "account" ADD COLUMN "issuer" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "account"
    WHERE "providerId" <> 'credential'
  ) THEN
    RAISE EXCEPTION 'Cannot automatically backfill issuer for non-credential accounts';
  END IF;
END $$;

UPDATE "account"
SET "issuer" = 'local:credential'
WHERE "providerId" = 'credential';

ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;

CREATE UNIQUE INDEX "account_issuer_accountId_key"
ON "account"("issuer", "accountId");
