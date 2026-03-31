-- CreateEnum
CREATE TYPE "MuxProcessingStatus" AS ENUM ('connecting', 'connected', 'paused', 'transcribing', 'disconnected', 'error');

-- CreateEnum
CREATE TYPE "MuxLiveStatus" AS ENUM ('active', 'disabled', 'idle');

-- CreateTable
CREATE TABLE "mux_live_session" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "hostToken" TEXT NOT NULL,
    "ingestToken" TEXT NOT NULL,
    "streamKey" TEXT NOT NULL,
    "publishUrl" TEXT NOT NULL,
    "playbackId" TEXT,
    "playbackUrl" TEXT,
    "audioOnly" BOOLEAN NOT NULL DEFAULT true,
    "muxStatus" "MuxLiveStatus" NOT NULL DEFAULT 'idle',
    "status" "MuxProcessingStatus" NOT NULL DEFAULT 'connecting',
    "error" TEXT,
    "workerRunning" BOOLEAN NOT NULL DEFAULT false,
    "hasEverBeenActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "mux_live_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mux_transcript_entry" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "lowConfidence" BOOLEAN,
    "timestampMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mux_transcript_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mux_live_session_hostToken_key" ON "mux_live_session"("hostToken");

-- CreateIndex
CREATE UNIQUE INDEX "mux_live_session_ingestToken_key" ON "mux_live_session"("ingestToken");

-- CreateIndex
CREATE INDEX "mux_live_session_ownerUserId_endedAt_updatedAt_idx" ON "mux_live_session"("ownerUserId", "endedAt", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "mux_live_session_endedAt_updatedAt_idx" ON "mux_live_session"("endedAt", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "mux_transcript_entry_sessionId_createdAt_idx" ON "mux_transcript_entry"("sessionId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "mux_live_session" ADD CONSTRAINT "mux_live_session_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mux_transcript_entry" ADD CONSTRAINT "mux_transcript_entry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "mux_live_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
