-- CreateEnum
CREATE TYPE "TranscriptSessionSource" AS ENUM ('microphone', 'livestream', 'mux', 'rtmp');

-- CreateTable
CREATE TABLE "transcript_session" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceType" "TranscriptSessionSource" NOT NULL,
    "sourceTitle" TEXT,
    "previewText" TEXT,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transcript_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_session_entry" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "lowConfidence" BOOLEAN,
    "timestampMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_session_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transcript_session_ownerUserId_archivedAt_updatedAt_idx" ON "transcript_session"("ownerUserId", "archivedAt", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "transcript_session_ownerUserId_updatedAt_idx" ON "transcript_session"("ownerUserId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "transcript_session_entry_sessionId_createdAt_idx" ON "transcript_session_entry"("sessionId", "createdAt" ASC);

-- AddForeignKey
ALTER TABLE "transcript_session" ADD CONSTRAINT "transcript_session_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_session_entry" ADD CONSTRAINT "transcript_session_entry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "transcript_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
