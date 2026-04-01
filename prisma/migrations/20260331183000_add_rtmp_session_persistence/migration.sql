-- CreateTable
CREATE TABLE "rtmp_session" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "hostToken" TEXT NOT NULL,
    "ingestToken" TEXT NOT NULL,
    "streamKey" TEXT NOT NULL,
    "publishUrl" TEXT NOT NULL,
    "sourceTitle" TEXT,
    "status" "MuxProcessingStatus" NOT NULL DEFAULT 'connecting',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "rtmp_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rtmp_transcript_entry" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "lowConfidence" BOOLEAN,
    "timestampMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rtmp_transcript_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rtmp_session_hostToken_key" ON "rtmp_session"("hostToken");

-- CreateIndex
CREATE UNIQUE INDEX "rtmp_session_ingestToken_key" ON "rtmp_session"("ingestToken");

-- CreateIndex
CREATE UNIQUE INDEX "rtmp_session_streamKey_key" ON "rtmp_session"("streamKey");

-- CreateIndex
CREATE INDEX "rtmp_session_ownerUserId_endedAt_updatedAt_idx" ON "rtmp_session"("ownerUserId", "endedAt", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "rtmp_session_endedAt_updatedAt_idx" ON "rtmp_session"("endedAt", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "rtmp_transcript_entry_sessionId_createdAt_idx" ON "rtmp_transcript_entry"("sessionId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "rtmp_session" ADD CONSTRAINT "rtmp_session_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rtmp_transcript_entry" ADD CONSTRAINT "rtmp_transcript_entry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "rtmp_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
