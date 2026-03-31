import { randomUUID } from "node:crypto"

import type { TranscriptEntry } from "@/components/transcriber-ui"
import { sharedSessionManager } from "@/lib/shared-session-manager"
import prisma from "@/lib/prisma"
import {
  MUX_RTMP_PUBLISH_URL,
  getMuxDashboardUrl,
  getMuxPlaybackUrl,
  getPublicMuxPlaybackId,
} from "@/lib/mux-live-utils"
import type {
  MuxLiveStatus,
  MuxProcessingStatus,
  MuxSessionSnapshot,
  MuxSessionSummary,
} from "@/lib/mux-session-types"
import {
  dedupeBoundaryText,
  normalizeWhitespace,
} from "@/lib/transcript-text-utils"

type MuxSessionEvent =
  | { type: "snapshot"; snapshot: MuxSessionSnapshot }
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "status"; error?: string; muxStatus?: MuxLiveStatus; status: MuxProcessingStatus }

interface MuxLiveStreamLike {
  audio_only?: boolean | null
  id: string
  playback_ids?: Array<{ id?: string | null; policy?: string | null }> | null
  status?: MuxLiveStatus | null
  stream_key?: string | null
}

interface MuxWorkerStartPayload {
  ingestToken: string
  playbackUrl: string
  sessionId: string
}

const MAX_TRANSCRIPT_ENTRIES = 500
const ACTIVE_SESSION_LOOKBACK_MS = 6 * 60 * 60 * 1000
const DEFAULT_SHARED_SOURCE_TITLE = "Church live translation"

class MuxSessionManager {
  private readonly listeners = new Map<string, Set<(event: MuxSessionEvent) => void>>()

  private hasMeaningfulSyncChange({
    liveStream,
    nextMuxStatus,
    nextPlaybackId,
    nextPlaybackUrl,
    nextStreamKey,
    session,
  }: {
    liveStream: MuxLiveStreamLike
    nextMuxStatus: MuxLiveStatus
    nextPlaybackId: string | null
    nextPlaybackUrl: string | null
    nextStreamKey: string
    session: Awaited<ReturnType<typeof prisma.muxLiveSession.findUnique>>
  }) {
    if (!session) {
      return false
    }

    const nextAudioOnly = Boolean(liveStream.audio_only ?? session.audioOnly)
    const nextEndedAt =
      nextMuxStatus === "deleted" ? (session.endedAt ?? new Date()) : session.endedAt
    const nextStatus =
      nextMuxStatus === "deleted"
        ? "disconnected"
        : nextMuxStatus === "idle" &&
            session.status !== "paused" &&
            session.status !== "error"
          ? "connecting"
          : session.status
    const nextWorkerRunning = nextMuxStatus === "deleted" ? false : session.workerRunning
    const nextHasEverBeenActive =
      nextMuxStatus === "active" ? true : session.hasEverBeenActive

    return (
      nextAudioOnly !== session.audioOnly ||
      nextEndedAt?.getTime() !== session.endedAt?.getTime() ||
      nextHasEverBeenActive !== session.hasEverBeenActive ||
      nextMuxStatus !== session.muxStatus ||
      nextPlaybackId !== session.playbackId ||
      nextPlaybackUrl !== session.playbackUrl ||
      nextStatus !== session.status ||
      nextStreamKey !== session.streamKey ||
      nextWorkerRunning !== session.workerRunning ||
      session.error !== null
    )
  }

  private emit(sessionId: string, event: MuxSessionEvent) {
    const listeners = this.listeners.get(sessionId)
    if (!listeners) {
      return
    }

    for (const listener of listeners) {
      listener(event)
    }
  }

  private toEntry(entry: {
    createdAt: Date
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
    session: {
      audioOnly: boolean
      createdAt: Date
      error: string | null
      id: string
      muxStatus: MuxLiveStatus
      playbackId: string | null
      playbackUrl: string | null
      sharedSessionCode: string
      sharedSessionId: string
      status: MuxProcessingStatus
      streamKey: string
      updatedAt: Date
    },
    entries: TranscriptEntry[]
  ): MuxSessionSnapshot {
    return {
      audioOnly: session.audioOnly,
      createdAt: session.createdAt.getTime(),
      dashboardUrl: getMuxDashboardUrl(session.id),
      entries,
      error: session.error ?? undefined,
      id: session.id,
      muxStatus: session.muxStatus,
      playbackId: session.playbackId,
      playbackUrl: session.playbackUrl,
      publishUrl: MUX_RTMP_PUBLISH_URL,
      sharedSessionCode: session.sharedSessionCode,
      sharedSessionId: session.sharedSessionId,
      status: session.status,
      streamKey: session.streamKey,
      updatedAt: session.updatedAt.getTime(),
    }
  }

  private toSummary(session: {
    audioOnly: boolean
    id: string
    muxStatus: MuxLiveStatus
    playbackId: string | null
    sharedSessionCode: string
    sharedSessionId: string
    status: MuxProcessingStatus
    streamKey: string
    updatedAt: Date
  }): MuxSessionSummary {
    return {
      audioOnly: session.audioOnly,
      dashboardUrl: getMuxDashboardUrl(session.id),
      id: session.id,
      muxStatus: session.muxStatus,
      playbackId: session.playbackId,
      publishUrl: MUX_RTMP_PUBLISH_URL,
      sharedSessionCode: session.sharedSessionCode,
      sharedSessionId: session.sharedSessionId,
      status: session.status,
      streamKey: session.streamKey,
      updatedAt: session.updatedAt.getTime(),
    }
  }

  private async loadRecentEntries(sessionId: string) {
    const rows = await prisma.muxTranscriptEntry.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
      take: MAX_TRANSCRIPT_ENTRIES,
    })

    return rows.reverse().map((entry) => this.toEntry(entry))
  }

  private async ensureSharedSessionLoaded(session: {
    createdAt: Date
    endedAt: Date | null
    id: string
    sharedSessionCode: string
    sharedSessionHostToken: string
    sharedSessionId: string
  }) {
    const entries = await this.loadRecentEntries(session.id)
    return sharedSessionManager.ensureSession({
      code: session.sharedSessionCode,
      createdAt: session.createdAt.getTime(),
      entries,
      hostToken: session.sharedSessionHostToken,
      id: session.sharedSessionId,
      sourceTitle: DEFAULT_SHARED_SOURCE_TITLE,
      sourceType: "livestream",
      status: session.endedAt ? "ended" : "active",
    })
  }

  async createSession({
    liveStream,
    ownerUserId,
  }: {
    liveStream: MuxLiveStreamLike
    ownerUserId: string
  }) {
    const playbackId = getPublicMuxPlaybackId(liveStream)
    const sharedSession = sharedSessionManager.createSession({
      sourceTitle: DEFAULT_SHARED_SOURCE_TITLE,
      sourceType: "livestream",
    })
    const session = await prisma.muxLiveSession.create({
      data: {
        audioOnly: Boolean(liveStream.audio_only),
        hostToken: randomUUID(),
        id: liveStream.id,
        ingestToken: randomUUID(),
        muxStatus: liveStream.status ?? "idle",
        ownerUserId,
        playbackId,
        playbackUrl: getMuxPlaybackUrl(playbackId),
        publishUrl: MUX_RTMP_PUBLISH_URL,
        sharedSessionCode: sharedSession.snapshot.code,
        sharedSessionHostToken: sharedSession.hostToken,
        sharedSessionId: sharedSession.snapshot.id,
        status: "connecting",
        streamKey: liveStream.stream_key ?? "",
      },
    })

    return {
      hostToken: session.hostToken,
      ingestToken: session.ingestToken,
      snapshot: this.toSnapshot(session, []),
    }
  }

  async listOwnerSessions(ownerUserId: string) {
    const sessions = await prisma.muxLiveSession.findMany({
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
    const session = await prisma.muxLiveSession.findUnique({
      where: { id: sessionId },
    })

    if (!session || session.hostToken !== hostToken) {
      return null
    }

    await this.ensureSharedSessionLoaded(session)
    const entries = await this.loadRecentEntries(sessionId)
    return this.toSnapshot(session, entries)
  }

  async getOwnerSession(sessionId: string, ownerUserId: string) {
    const session = await prisma.muxLiveSession.findUnique({
      where: { id: sessionId },
    })

    if (!session || session.ownerUserId !== ownerUserId) {
      return null
    }

    await this.ensureSharedSessionLoaded(session)
    const entries = await this.loadRecentEntries(sessionId)
    return {
      hostToken: session.hostToken,
      snapshot: this.toSnapshot(session, entries),
    }
  }

  async getIngestSession(sessionId: string, ingestToken: string) {
    const session = await prisma.muxLiveSession.findUnique({
      where: { id: sessionId },
    })

    if (!session || session.ingestToken !== ingestToken) {
      return null
    }

    await this.ensureSharedSessionLoaded(session)
    return this.toSnapshot(session, [])
  }

  async ensureSharedSessionById(sharedSessionId: string) {
    const existing = sharedSessionManager.getSnapshotById(sharedSessionId)
    if (existing) {
      return existing
    }

    const session = await prisma.muxLiveSession.findUnique({
      where: { sharedSessionId },
      select: {
        createdAt: true,
        endedAt: true,
        id: true,
        sharedSessionCode: true,
        sharedSessionHostToken: true,
        sharedSessionId: true,
      },
    })

    if (!session) {
      return null
    }

    return (await this.ensureSharedSessionLoaded(session)).snapshot
  }

  async ensureSharedSessionByCode(sharedSessionCode: string) {
    const existing = sharedSessionManager.getSnapshotByCode(sharedSessionCode)
    if (existing) {
      return existing
    }

    const session = await prisma.muxLiveSession.findUnique({
      where: { sharedSessionCode },
      select: {
        createdAt: true,
        endedAt: true,
        id: true,
        sharedSessionCode: true,
        sharedSessionHostToken: true,
        sharedSessionId: true,
      },
    })

    if (!session) {
      return null
    }

    return (await this.ensureSharedSessionLoaded(session)).snapshot
  }

  async subscribe(
    sessionId: string,
    hostToken: string,
    listener: (event: MuxSessionEvent) => void
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

  async setHostStatus({
    hostToken,
    sessionId,
    status,
  }: {
    hostToken: string
    sessionId: string
    status: Extract<MuxProcessingStatus, "connected" | "paused">
  }) {
    const session = await prisma.muxLiveSession.findUnique({
      where: { id: sessionId },
    })
    if (!session || session.hostToken !== hostToken) {
      return false
    }

    await prisma.muxLiveSession.update({
      where: { id: sessionId },
      data: {
        error: null,
        status,
      },
    })

    this.emit(sessionId, {
      type: "status",
      muxStatus: session.muxStatus,
      status,
    })
    return true
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
    status: MuxProcessingStatus
  }) {
    const session = await prisma.muxLiveSession.findUnique({
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
        muxStatus: session.muxStatus,
        status: session.status,
      })
      return true
    }

    await prisma.muxLiveSession.update({
      where: { id: sessionId },
      data: {
        error: error ?? null,
        status,
        workerRunning: status === "disconnected" || status === "error" ? false : undefined,
      },
    })

    this.emit(sessionId, {
      type: "status",
      error,
      muxStatus: session.muxStatus,
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
    const session = await prisma.muxLiveSession.findUnique({
      where: { id: sessionId },
      select: {
        createdAt: true,
        endedAt: true,
        id: true,
        ingestToken: true,
        muxStatus: true,
        sharedSessionCode: true,
        sharedSessionHostToken: true,
        sharedSessionId: true,
        status: true,
      },
    })

    if (!session || session.ingestToken !== ingestToken) {
      return false
    }

    if (session.status === "paused" || session.endedAt || session.muxStatus === "deleted") {
      return true
    }

    const normalizedText = normalizeWhitespace(text)
    if (!normalizedText) {
      return true
    }

    const previousEntry = await prisma.muxTranscriptEntry.findFirst({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
      select: { text: true },
    })

    const dedupedText = dedupeBoundaryText(previousEntry?.text ?? "", normalizedText)
    if (!dedupedText) {
      return true
    }

    const createdEntry = await prisma.$transaction(async (tx) => {
      const entry = await tx.muxTranscriptEntry.create({
        data: {
          lowConfidence,
          sessionId,
          text: dedupedText,
          timestampMs: Date.now() - session.createdAt.getTime(),
        },
      })

      await tx.muxLiveSession.update({
        where: { id: sessionId },
        data: {
          error: null,
          status: "connected",
        },
      })

      return entry
    })

    const entry = this.toEntry(createdEntry)
    await this.ensureSharedSessionLoaded({
      createdAt: session.createdAt,
      endedAt: null,
      id: session.id,
      sharedSessionCode: session.sharedSessionCode,
      sharedSessionHostToken: session.sharedSessionHostToken,
      sharedSessionId: session.sharedSessionId,
    })
    sharedSessionManager.appendEntry({
      entry,
      hostToken: session.sharedSessionHostToken,
      sessionId: session.sharedSessionId,
    })
    this.emit(sessionId, { type: "entry", entry })
    this.emit(sessionId, {
      type: "status",
      muxStatus: session.muxStatus,
      status: "connected",
    })
    return true
  }

  async syncFromMuxLiveStream(liveStream: MuxLiveStreamLike) {
    const session = await prisma.muxLiveSession.findUnique({
      where: { id: liveStream.id },
    })
    if (!session) {
      return null
    }

    const nextMuxStatus = liveStream.status ?? session.muxStatus
    const nextPlaybackId = getPublicMuxPlaybackId(liveStream) ?? session.playbackId
    const nextPlaybackUrl = getMuxPlaybackUrl(nextPlaybackId)
    const nextStreamKey = liveStream.stream_key ?? session.streamKey
    const hasMeaningfulChange = this.hasMeaningfulSyncChange({
      liveStream,
      nextMuxStatus,
      nextPlaybackId,
      nextPlaybackUrl,
      nextStreamKey,
      session,
    })

    if (!hasMeaningfulChange) {
      return this.toSnapshot(session, await this.loadRecentEntries(liveStream.id))
    }

    const nextStatus =
      nextMuxStatus === "deleted"
        ? "disconnected"
        : nextMuxStatus === "idle" &&
            session.status !== "paused" &&
            session.status !== "error"
          ? "connecting"
          : session.status

    const updated = await prisma.muxLiveSession.update({
      where: { id: liveStream.id },
      data: {
        audioOnly: Boolean(liveStream.audio_only ?? session.audioOnly),
        endedAt:
          nextMuxStatus === "deleted" ? (session.endedAt ?? new Date()) : session.endedAt,
        error: null,
        hasEverBeenActive: nextMuxStatus === "active" ? true : session.hasEverBeenActive,
        muxStatus: nextMuxStatus,
        playbackId: nextPlaybackId,
        playbackUrl: nextPlaybackUrl,
        status: nextStatus,
        streamKey: nextStreamKey,
        workerRunning: nextMuxStatus === "deleted" ? false : session.workerRunning,
      },
    })

    await this.ensureSharedSessionLoaded(updated)
    sharedSessionManager.updateMetadata({
      hostToken: updated.sharedSessionHostToken,
      sessionId: updated.sharedSessionId,
      sourceTitle: DEFAULT_SHARED_SOURCE_TITLE,
    })
    if (updated.endedAt) {
      sharedSessionManager.endSession({
        hostToken: updated.sharedSessionHostToken,
        sessionId: updated.sharedSessionId,
      })
    }
    this.emit(liveStream.id, {
      type: "status",
      muxStatus: updated.muxStatus,
      status: updated.status,
    })

    return this.toSnapshot(updated, await this.loadRecentEntries(liveStream.id))
  }

  async prepareWorkerStart(sessionId: string): Promise<MuxWorkerStartPayload | null> {
    return prisma.$transaction(async (tx) => {
      const session = await tx.muxLiveSession.findUnique({
        where: { id: sessionId },
      })

      if (
        !session ||
        session.endedAt ||
        !session.playbackUrl ||
        session.workerRunning ||
        session.muxStatus !== "active"
      ) {
        return null
      }

      const updated = await tx.muxLiveSession.update({
        where: { id: sessionId },
        data: {
          status: session.status === "paused" ? session.status : "connecting",
          workerRunning: true,
        },
      })

      this.emit(sessionId, {
        type: "status",
        muxStatus: updated.muxStatus,
        status: updated.status,
      })

      return {
        ingestToken: updated.ingestToken,
        playbackUrl: updated.playbackUrl ?? "",
        sessionId: updated.id,
      }
    })
  }

  async prepareWorkerStop(sessionId: string) {
    const session = await prisma.muxLiveSession.findUnique({
      where: { id: sessionId },
    })

    if (!session || !session.workerRunning) {
      return null
    }

    const updated = await prisma.muxLiveSession.update({
      where: { id: sessionId },
      data: {
        status:
          session.muxStatus === "deleted"
            ? "disconnected"
            : session.muxStatus === "idle" && session.status !== "paused"
              ? "connecting"
              : session.status,
        workerRunning: false,
      },
    })

    await this.ensureSharedSessionLoaded(updated)
    sharedSessionManager.endSession({
      hostToken: updated.sharedSessionHostToken,
      sessionId: updated.sharedSessionId,
    })
    this.emit(sessionId, {
      type: "status",
      muxStatus: updated.muxStatus,
      status: updated.status,
    })
    return { sessionId: updated.id }
  }

  async handleWorkerStartFailure(sessionId: string, error: string) {
    const session = await prisma.muxLiveSession.findUnique({
      where: { id: sessionId },
    })
    if (!session) {
      return false
    }

    const updated = await prisma.muxLiveSession.update({
      where: { id: sessionId },
      data: {
        error,
        status: "error",
        workerRunning: false,
      },
    })

    this.emit(sessionId, {
      type: "status",
      error,
      muxStatus: updated.muxStatus,
      status: updated.status,
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
    const session = await prisma.muxLiveSession.findUnique({
      where: { id: sessionId },
    })
    if (!session || session.hostToken !== hostToken) {
      return false
    }

    const updated = await prisma.muxLiveSession.update({
      where: { id: sessionId },
      data: {
        endedAt: new Date(),
        muxStatus: "deleted",
        status: "disconnected",
        workerRunning: false,
      },
    })

    this.emit(sessionId, {
      type: "status",
      muxStatus: updated.muxStatus,
      status: updated.status,
    })
    return true
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __muxSessionManager__: MuxSessionManager | undefined
  // eslint-disable-next-line no-var
  var __muxSessionManagerVersion__: number | undefined
}

const MUX_SESSION_MANAGER_VERSION = 4

const shouldCreateManager =
  !globalThis.__muxSessionManager__ ||
  globalThis.__muxSessionManagerVersion__ !== MUX_SESSION_MANAGER_VERSION ||
  typeof globalThis.__muxSessionManager__.listOwnerSessions !== "function" ||
  typeof globalThis.__muxSessionManager__.prepareWorkerStart !== "function" ||
  typeof globalThis.__muxSessionManager__.ensureSharedSessionByCode !== "function"

const managerInstance: MuxSessionManager = shouldCreateManager
  ? new MuxSessionManager()
  : globalThis.__muxSessionManager__!

export const muxSessionManager = managerInstance

if (shouldCreateManager) {
  globalThis.__muxSessionManager__ = managerInstance
  globalThis.__muxSessionManagerVersion__ = MUX_SESSION_MANAGER_VERSION
}
