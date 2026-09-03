import { cacheLife, cacheTag } from "next/cache"

import type { TranscriptEntry } from "@/components/transcriber-ui"
import prisma from "@/lib/prisma"
import type {
  TranscriptSessionDetail,
  TranscriptSessionListPayload,
  TranscriptSessionSource,
  TranscriptSessionSummary,
} from "@/lib/transcript-session-types"

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

export function getTranscriptSessionListTag(ownerUserId: string) {
  return `transcript-sessions:${ownerUserId}`
}

export function getTranscriptSessionDetailTag(ownerUserId: string, sessionId: string) {
  return `transcript-session:${ownerUserId}:${sessionId}`
}

function defaultSessionTitle({
  endedAt,
  sourceTitle,
  sourceType,
}: {
  endedAt: Date
  sourceTitle?: string
  sourceType: TranscriptSessionSource
}) {
  if (sourceTitle) {
    return sourceTitle
  }

  const baseLabel =
    sourceType === "microphone"
      ? "Live Mic"
      : sourceType === "livestream"
        ? "YouTube Live"
        : sourceType === "mux"
          ? "Mux managed ingest"
          : "RTMP ingest"

  return `${baseLabel} ${endedAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })}`
}

function toSummary(session: {
  archivedAt: Date | null
  endedAt: Date
  entryCount: number
  id: string
  previewText: string | null
  sourceTitle: string | null
  sourceType: TranscriptSessionSource
  startedAt: Date
  title: string
  updatedAt: Date
}): TranscriptSessionSummary {
  return {
    archivedAt: session.archivedAt?.getTime(),
    endedAt: session.endedAt.getTime(),
    entryCount: session.entryCount,
    id: session.id,
    previewText: session.previewText ?? undefined,
    sourceTitle: session.sourceTitle ?? undefined,
    sourceType: session.sourceType,
    startedAt: session.startedAt.getTime(),
    title: session.title,
    updatedAt: session.updatedAt.getTime(),
  }
}

export async function listTranscriptSessions(
  ownerUserId: string
): Promise<TranscriptSessionListPayload> {
  "use cache"
  cacheLife("minutes")
  cacheTag(getTranscriptSessionListTag(ownerUserId))

  const sessions = await prisma.transcriptSession.findMany({
    where: { ownerUserId },
    orderBy: { updatedAt: "desc" },
    select: {
      archivedAt: true,
      endedAt: true,
      entryCount: true,
      id: true,
      previewText: true,
      sourceTitle: true,
      sourceType: true,
      startedAt: true,
      title: true,
      updatedAt: true,
    },
    take: 100,
  })

  const active: TranscriptSessionSummary[] = []
  const archived: TranscriptSessionSummary[] = []

  for (const session of sessions) {
    const summary = toSummary(session)
    if (session.archivedAt) {
      archived.push(summary)
    } else {
      active.push(summary)
    }
  }

  return { active, archived }
}

export async function getTranscriptSessionDetail(args: {
  ownerUserId: string
  sessionId: string
}): Promise<TranscriptSessionDetail | null> {
  "use cache"
  cacheLife("minutes")
  cacheTag(
    getTranscriptSessionListTag(args.ownerUserId),
    getTranscriptSessionDetailTag(args.ownerUserId, args.sessionId)
  )

  const session = await prisma.transcriptSession.findUnique({
    where: { id: args.sessionId },
    include: {
      entries: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          lowConfidence: true,
          text: true,
          timestampMs: true,
        },
      },
    },
  })

  if (!session || session.ownerUserId !== args.ownerUserId) {
    return null
  }

  return {
    ...toSummary(session),
    entries: session.entries.map((entry: {
      id: string
      lowConfidence: boolean | null
      text: string
      timestampMs: number
    }) => ({
      id: entry.id,
      lowConfidence: entry.lowConfidence ?? undefined,
      text: entry.text,
      timestampMs: entry.timestampMs,
    })),
  }
}

export async function createTranscriptSession(args: {
  endedAt?: number
  entries: TranscriptEntry[]
  ownerUserId: string
  sourceTitle?: string
  sourceType: TranscriptSessionSource
  startedAt?: number
  title?: string
}) {
  const filteredEntries = args.entries
    .map((entry) => ({
      ...entry,
      text: normalizeWhitespace(entry.text),
    }))
    .filter((entry) => entry.text)

  if (filteredEntries.length === 0) {
    return null
  }

  const startedAt = new Date(args.startedAt ?? Date.now())
  const endedAt = new Date(args.endedAt ?? Date.now())
  const previewText = filteredEntries[0]?.text?.slice(0, 180) ?? null
  const title = normalizeWhitespace(
    args.title ||
      defaultSessionTitle({
        endedAt,
        sourceTitle: args.sourceTitle,
        sourceType: args.sourceType,
      })
  )

  const session = await prisma.transcriptSession.create({
    data: {
      endedAt,
      entryCount: filteredEntries.length,
      ownerUserId: args.ownerUserId,
      previewText,
      sourceTitle: args.sourceTitle,
      sourceType: args.sourceType,
      startedAt,
      title,
      entries: {
        create: filteredEntries.map((entry) => ({
          lowConfidence: entry.lowConfidence,
          text: entry.text,
          timestampMs: entry.timestampMs,
        })),
      },
    },
    include: {
      entries: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          lowConfidence: true,
          text: true,
          timestampMs: true,
        },
      },
    },
  })

  return {
    detail: {
      ...toSummary(session),
      entries: session.entries.map((entry: {
        id: string
        lowConfidence: boolean | null
        text: string
        timestampMs: number
      }) => ({
        id: entry.id,
        lowConfidence: entry.lowConfidence ?? undefined,
        text: entry.text,
        timestampMs: entry.timestampMs,
      })),
    } satisfies TranscriptSessionDetail,
    summary: toSummary(session),
  }
}

export async function updateTranscriptSession(args: {
  archived?: boolean
  ownerUserId: string
  sessionId: string
  title?: string
}) {
  const existing = await prisma.transcriptSession.findUnique({
    where: { id: args.sessionId },
  })

  if (!existing || existing.ownerUserId !== args.ownerUserId) {
    return null
  }

  const nextTitle =
    typeof args.title === "string" ? normalizeWhitespace(args.title) : undefined

  const updated = await prisma.transcriptSession.update({
    where: { id: args.sessionId },
    data: {
      archivedAt:
        typeof args.archived === "boolean"
          ? args.archived
            ? existing.archivedAt ?? new Date()
            : null
          : undefined,
      title: nextTitle || undefined,
    },
    select: {
      archivedAt: true,
      endedAt: true,
      entryCount: true,
      id: true,
      previewText: true,
      sourceTitle: true,
      sourceType: true,
      startedAt: true,
      title: true,
      updatedAt: true,
    },
  })

  return toSummary(updated)
}

export async function deleteTranscriptSession(args: {
  ownerUserId: string
  sessionId: string
}) {
  const existing = await prisma.transcriptSession.findUnique({
    where: { id: args.sessionId },
    select: { id: true, ownerUserId: true },
  })

  if (!existing || existing.ownerUserId !== args.ownerUserId) {
    return false
  }

  await prisma.transcriptSession.delete({
    where: { id: args.sessionId },
  })

  return true
}
