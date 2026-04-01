-- CreateEnum
CREATE TYPE "SharedSessionSource" AS ENUM ('microphone', 'livestream');

-- CreateEnum
CREATE TYPE "SharedSessionStatus" AS ENUM ('active', 'ended');

-- CreateTable
CREATE TABLE "shared_session" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "hostToken" TEXT NOT NULL,
    "sourceType" "SharedSessionSource" NOT NULL,
    "sourceTitle" TEXT,
    "status" "SharedSessionStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "shared_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared_session_entry" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "lowConfidence" BOOLEAN,
    "timestampMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_session_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shared_session_code_key" ON "shared_session"("code");

-- CreateIndex
CREATE UNIQUE INDEX "shared_session_hostToken_key" ON "shared_session"("hostToken");

-- CreateIndex
CREATE INDEX "shared_session_endedAt_updatedAt_idx" ON "shared_session"("endedAt", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "shared_session_entry_sessionId_createdAt_idx" ON "shared_session_entry"("sessionId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "shared_session_entry" ADD CONSTRAINT "shared_session_entry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "shared_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
