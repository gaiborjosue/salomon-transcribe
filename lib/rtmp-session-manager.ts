import { randomUUID } from "node:crypto"

import type { TranscriptEntry } from "@/components/transcriber-ui"
import prisma from "@/lib/prisma"
import type {
  RtmpSessionSnapshot,
  RtmpSessionStatus,
  RtmpSessionSummary,
} from "@/lib/rtmp-types"
import {
  dedupeBoundaryText,
  normalizeWhitespace,
} from "@/lib/transcript-text-utils"

type RtmpSessionEvent =
  | { type: "snapshot"; snapshot: RtmpSessionSnapshot }
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "status"; error?: string; status: RtmpSessionStatus }

const MAX_ENTRIES = 500
const ACTIVE_SESSION_LOOKBACK_MS = 6 * 60 * 60 * 1000
const STREAM_KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const STREAM_KEY_LENGTH = 14

interface RtmpPersistedSession {
  createdAt: Date
  error: string | null
  id: string
  publishUrl: string
  sourceTitle: string | null
  status: RtmpSessionStatus
  streamKey: string
  updatedAt: Date
}

function generateStreamKey() {
  let key = "sal_"
  for (let index = 0; index < STREAM_KEY_LENGTH; index++) {
    key += STREAM_KEY_ALPHABET[Math.floor(Math.random() * STREAM_KEY_ALPHABET.length)]
  }
  return key
}

function buildPublishUrl(streamKey: string) {
  const baseUrl = process.env.RTMP_PUBLISH_BASE_URL ?? "rtmp://localhost:1935/live"
  return `${baseUrl.replace(/\/+$/u, "")}/${streamKey}`
}

class RtmpSessionManager {
  private readonly listeners = new Map<string, Set<(event: RtmpSessionEvent) => void>>()

  private emit(sessionId: string, event: RtmpSessionEvent) {
    const listeners = this.listeners.get(sessionId)
    if (!listeners) {
      return
    }

    for (const listener of listeners) {
      listener(event)
    }
  }

  private toEntry(entry: {
    id: string
    lowConfidence: boolean | null
    text: string
    timestampMs: number
  }): TranscriptEntry {
    return {
      id: entry.id,
      lowConfidence: entry.lowConfidence ?? undefined,
      text: entry.text,
      timestampMs: entry.timestampMs,
    }
  }

  private toSnapshot(
    session: RtmpPersistedSession,
    entries: TranscriptEntry[]
  ): RtmpSessionSnapshot {
    return {
      createdAt: session.createdAt.getTime(),
      entries,
      error: session.error ?? undefined,
      id: session.id,
      publishUrl: session.publishUrl,
      sourceTitle: session.sourceTitle ?? undefined,
      status: session.status,
      streamKey: session.streamKey,
      updatedAt: session.updatedAt.getTime(),
    }
  }

  private toSummary(session: {
    id: string
    publishUrl: string
    sourceTitle: string | null
    status: RtmpSessionStatus
    streamKey: string
    updatedAt: Date
  }): RtmpSessionSummary {
    return {
      id: session.id,
      publishUrl: session.publishUrl,
      sourceTitle: session.sourceTitle ?? undefined,
      status: session.status,
      streamKey: session.streamKey,
      updatedAt: session.updatedAt.getTime(),
    }
  }

  private async loadRecentEntries(sessionId: string) {
    const rows = await prisma.rtmpTranscriptEntry.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
      take: MAX_ENTRIES,
    })

    return rows.reverse().map((entry) => this.toEntry(entry))
  }

  async createSession({
    ownerUserId,
    sourceTitle,
  }: {
    ownerUserId: string
    sourceTitle?: string
  }) {
    let streamKey = generateStreamKey()
    let existing = await prisma.rtmpSession.findUnique({
      where: { streamKey },
      select: { id: true },
    })

    while (existing) {
      streamKey = generateStreamKey()
      existing = await prisma.rtmpSession.findUnique({
        where: { streamKey },
        select: { id: true },
      })
    }

    const session = await prisma.rtmpSession.create({
      data: {
        hostToken: randomUUID(),
        id: randomUUID(),
        ingestToken: randomUUID(),
        ownerUserId,
        publishUrl: buildPublishUrl(streamKey),
        sourceTitle,
        status: "connecting",
        streamKey,
      },
    })

    return {
      hostToken: session.hostToken,
      ingestToken: session.ingestToken,
      snapshot: this.toSnapshot(session, []),
    }
  }

  async listOwnerSessions(ownerUserId: string) {
    const sessions = await prisma.rtmpSession.findMany({
      where: {
        ownerUserId,
        endedAt: null,
        updatedAt: {
          gte: new Date(Date.now() - ACTIVE_SESSION_LOOKBACK_MS),
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 12,
    })

    return sessions.map((session) => ({
      hostToken: session.hostToken,
      snapshot: this.toSummary(session),
    }))
  }

  async getHostSession(sessionId: string, hostToken: string) {
    const session = await prisma.rtmpSession.findUnique({
      where: { id: sessionId },
    })

    if (!session || session.hostToken !== hostToken) {
      return null
    }

    const entries = await this.loadRecentEntries(sessionId)
    return this.toSnapshot(session, entries)
  }

  async getOwnerSession(sessionId: string, ownerUserId: string) {
    const session = await prisma.rtmpSession.findUnique({
      where: { id: sessionId },
    })

    if (!session || session.ownerUserId !== ownerUserId) {
      return null
    }

    const entries = await this.loadRecentEntries(sessionId)
    return {
      hostToken: session.hostToken,
      snapshot: this.toSnapshot(session, entries),
    }
  }

  async getIngestSession(sessionId: string, ingestToken: string) {
    const session = await prisma.rtmpSession.findUnique({
      where: { id: sessionId },
    })

    if (!session || session.ingestToken !== ingestToken) {
      return null
    }

    return this.toSnapshot(session, [])
  }

  async subscribe(
    sessionId: string,
    hostToken: string,
    listener: (event: RtmpSessionEvent) => void
  ) {
    const snapshot = await this.getHostSession(sessionId, hostToken)
    if (!snapshot) {
      return null
    }

    const listeners = this.listeners.get(sessionId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)

    listener({
      type: "snapshot",
      snapshot,
    })

    return () => {
      const current = this.listeners.get(sessionId)
      if (!current) {
        return
      }

      current.delete(listener)
      if (current.size === 0) {
        this.listeners.delete(sessionId)
      }
    }
  }

  async updateStatus({
    error,
    ingestToken,
    sessionId,
    status,
  }: {
    error?: string
    ingestToken: string
    sessionId: string
    status: RtmpSessionStatus
  }) {
    const session = await prisma.rtmpSession.findUnique({
      where: { id: sessionId },
    })

    if (!session || session.ingestToken !== ingestToken) {
      return false
    }

    const shouldPreservePaused =
      session.status === "paused" &&
      status !== "paused" &&
      status !== "disconnected" &&
      status !== "error"

    if (shouldPreservePaused) {
      this.emit(sessionId, {
        type: "status",
        status: session.status,
      })
      return true
    }

    await prisma.rtmpSession.update({
      where: { id: sessionId },
      data: {
        error: error ?? null,
        endedAt: status === "disconnected" ? session.endedAt ?? new Date() : session.endedAt,
        status,
      },
    })

    this.emit(sessionId, {
      type: "status",
      error,
      status,
    })
    return true
  }

  async setHostStatus({
    hostToken,
    sessionId,
    status,
  }: {
    hostToken: string
    sessionId: string
    status: Extract<RtmpSessionStatus, "connected" | "paused">
  }) {
    const session = await prisma.rtmpSession.findUnique({
      where: { id: sessionId },
    })

    if (!session || session.hostToken !== hostToken || session.endedAt) {
      return false
    }

    await prisma.rtmpSession.update({
      where: { id: sessionId },
      data: {
        error: null,
        status,
      },
    })

    this.emit(sessionId, {
      type: "status",
      status,
    })
    return true
  }

  async appendEntry({
    ingestToken,
    lowConfidence,
    sessionId,
    text,
  }: {
    ingestToken: string
    lowConfidence?: boolean
    sessionId: string
    text: string
  }) {
    const session = await prisma.rtmpSession.findUnique({
      where: { id: sessionId },
      select: {
        createdAt: true,
        endedAt: true,
        id: true,
        ingestToken: true,
        status: true,
      },
    })

    if (!session || session.ingestToken !== ingestToken) {
      return false
    }

    if (session.status === "paused" || session.endedAt) {
      return true
    }

    const normalizedText = normalizeWhitespace(text)
    if (!normalizedText) {
      return true
    }

    const previousEntry = await prisma.rtmpTranscriptEntry.findFirst({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
      select: { text: true },
    })

    const dedupedText = dedupeBoundaryText(previousEntry?.text ?? "", normalizedText)
    if (!dedupedText) {
      return true
    }

    const createdEntry = await prisma.$transaction(async (tx) => {
      const entry = await tx.rtmpTranscriptEntry.create({
        data: {
          lowConfidence,
          sessionId,
          text: dedupedText,
          timestampMs: Date.now() - session.createdAt.getTime(),
        },
      })

      await tx.rtmpSession.update({
        where: { id: sessionId },
        data: {
          error: null,
          status: "connected",
        },
      })

      return entry
    })

    const entry = this.toEntry(createdEntry)
    this.emit(sessionId, { type: "entry", entry })
    this.emit(sessionId, {
      type: "status",
      status: "connected",
    })
    return true
  }

  async endByHost({
    hostToken,
    sessionId,
  }: {
    hostToken: string
    sessionId: string
  }) {
    const session = await prisma.rtmpSession.findUnique({
      where: { id: sessionId },
    })

    if (!session || session.hostToken !== hostToken) {
      return false
    }

    const updated = await prisma.rtmpSession.update({
      where: { id: sessionId },
      data: {
        endedAt: session.endedAt ?? new Date(),
        status: "disconnected",
      },
    })

    this.emit(sessionId, {
      type: "status",
      status: updated.status,
    })
    return true
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __rtmpSessionManager__: RtmpSessionManager | undefined
  // eslint-disable-next-line no-var
  var __rtmpSessionManagerVersion__: number | undefined
}

const RTMP_SESSION_MANAGER_VERSION = 3

const shouldCreateManager =
  !globalThis.__rtmpSessionManager__ ||
  globalThis.__rtmpSessionManagerVersion__ !== RTMP_SESSION_MANAGER_VERSION ||
  typeof globalThis.__rtmpSessionManager__.listOwnerSessions !== "function" ||
  typeof globalThis.__rtmpSessionManager__.getOwnerSession !== "function"

const managerInstance: RtmpSessionManager = shouldCreateManager
  ? new RtmpSessionManager()
  : globalThis.__rtmpSessionManager__!

export const rtmpSessionManager = managerInstance

if (shouldCreateManager) {
  globalThis.__rtmpSessionManager__ = managerInstance
  globalThis.__rtmpSessionManagerVersion__ = RTMP_SESSION_MANAGER_VERSION
}
