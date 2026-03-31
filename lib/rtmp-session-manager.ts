import { randomUUID } from "node:crypto"

import type { TranscriptEntry } from "@/components/transcriber-ui"
import type { RtmpSessionSnapshot, RtmpSessionStatus } from "@/lib/rtmp-types"
import {
  dedupeBoundaryText,
  normalizeWhitespace,
} from "@/lib/transcript-text-utils"

type RtmpSessionEvent =
  | { type: "snapshot"; snapshot: RtmpSessionSnapshot }
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "status"; error?: string; status: RtmpSessionStatus }

interface RtmpSessionRecord {
  createdAt: number
  entries: TranscriptEntry[]
  error?: string
  hostToken: string
  id: string
  ingestToken: string
  listeners: Set<(event: RtmpSessionEvent) => void>
  sourceTitle?: string
  status: RtmpSessionStatus
  streamKey: string
  updatedAt: number
}

const MAX_ENTRIES = 500
const SESSION_TTL_MS = 6 * 60 * 60 * 1000
const STREAM_KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const STREAM_KEY_LENGTH = 14

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
  private readonly sessions = new Map<string, RtmpSessionRecord>()

  private cleanupExpiredSessions() {
    const now = Date.now()

    for (const [id, session] of this.sessions.entries()) {
      if (session.listeners.size > 0) {
        continue
      }

      if (
        session.status === "disconnected" ||
        session.status === "error" ||
        now - session.updatedAt > SESSION_TTL_MS
      ) {
        this.sessions.delete(id)
      }
    }
  }

  private toSnapshot(session: RtmpSessionRecord): RtmpSessionSnapshot {
    return {
      createdAt: session.createdAt,
      entries: session.entries,
      error: session.error,
      id: session.id,
      publishUrl: buildPublishUrl(session.streamKey),
      sourceTitle: session.sourceTitle,
      status: session.status,
      streamKey: session.streamKey,
    }
  }

  private emit(session: RtmpSessionRecord, event: RtmpSessionEvent) {
    for (const listener of session.listeners) {
      listener(event)
    }
  }

  createSession({ sourceTitle }: { sourceTitle?: string }) {
    this.cleanupExpiredSessions()

    const session: RtmpSessionRecord = {
      createdAt: Date.now(),
      entries: [],
      hostToken: randomUUID(),
      id: randomUUID(),
      ingestToken: randomUUID(),
      listeners: new Set(),
      sourceTitle,
      status: "connecting",
      streamKey: generateStreamKey(),
      updatedAt: Date.now(),
    }

    this.sessions.set(session.id, session)

    return {
      hostToken: session.hostToken,
      ingestToken: session.ingestToken,
      snapshot: this.toSnapshot(session),
    }
  }

  getHostSession(sessionId: string, hostToken: string) {
    this.cleanupExpiredSessions()
    const session = this.sessions.get(sessionId)
    if (!session || session.hostToken !== hostToken) {
      return null
    }

    return this.toSnapshot(session)
  }

  getIngestSession(sessionId: string, ingestToken: string) {
    this.cleanupExpiredSessions()
    const session = this.sessions.get(sessionId)
    if (!session || session.ingestToken !== ingestToken) {
      return null
    }

    return this.toSnapshot(session)
  }

  subscribe(
    sessionId: string,
    hostToken: string,
    listener: (event: RtmpSessionEvent) => void
  ) {
    const session = this.sessions.get(sessionId)
    if (!session || session.hostToken !== hostToken) {
      return null
    }

    session.listeners.add(listener)
    session.updatedAt = Date.now()
    listener({
      type: "snapshot",
      snapshot: this.toSnapshot(session),
    })

    return () => {
      session.listeners.delete(listener)
      session.updatedAt = Date.now()
      this.cleanupExpiredSessions()
    }
  }

  updateStatus({
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
    const session = this.sessions.get(sessionId)
    if (!session || session.ingestToken !== ingestToken) {
      return false
    }

    const shouldPreservePaused =
      session.status === "paused" &&
      status !== "paused" &&
      status !== "disconnected" &&
      status !== "error"

    if (shouldPreservePaused) {
      this.emit(session, {
        type: "status",
        status: session.status,
      })
      return true
    }

    session.error = error
    session.status = status
    session.updatedAt = Date.now()
    this.emit(session, {
      type: "status",
      error,
      status,
    })
    return true
  }

  setHostStatus({
    hostToken,
    sessionId,
    status,
  }: {
    hostToken: string
    sessionId: string
    status: Extract<RtmpSessionStatus, "connected" | "paused">
  }) {
    const session = this.sessions.get(sessionId)
    if (!session || session.hostToken !== hostToken) {
      return false
    }

    session.status = status
    session.error = undefined
    session.updatedAt = Date.now()
    this.emit(session, {
      type: "status",
      status,
    })
    return true
  }

  appendEntry({
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
    const session = this.sessions.get(sessionId)
    if (!session || session.ingestToken !== ingestToken) {
      return false
    }

    if (session.status === "paused") {
      return true
    }

    const normalizedText = normalizeWhitespace(text)
    if (!normalizedText) {
      return true
    }

    const previousText = session.entries[session.entries.length - 1]?.text || ""
    const dedupedText = dedupeBoundaryText(previousText, normalizedText)
    if (!dedupedText) {
      return true
    }

    const entry: TranscriptEntry = {
      id: `${Date.now()}-${session.entries.length}`,
      lowConfidence,
      text: dedupedText,
      timestampMs: Date.now() - session.createdAt,
    }

    session.entries = [...session.entries, entry].slice(-MAX_ENTRIES)
    session.updatedAt = Date.now()
    session.error = undefined
    session.status = "connected"
    this.emit(session, { type: "entry", entry })
    this.emit(session, {
      type: "status",
      status: session.status,
    })
    return true
  }

  endByHost({
    hostToken,
    sessionId,
  }: {
    hostToken: string
    sessionId: string
  }) {
    const session = this.sessions.get(sessionId)
    if (!session || session.hostToken !== hostToken) {
      return false
    }

    session.status = "disconnected"
    session.updatedAt = Date.now()
    this.emit(session, {
      type: "status",
      status: session.status,
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

const RTMP_SESSION_MANAGER_VERSION = 2

const shouldCreateManager =
  !globalThis.__rtmpSessionManager__ ||
  globalThis.__rtmpSessionManagerVersion__ !== RTMP_SESSION_MANAGER_VERSION ||
  typeof globalThis.__rtmpSessionManager__.setHostStatus !== "function"

const managerInstance: RtmpSessionManager = shouldCreateManager
  ? new RtmpSessionManager()
  : globalThis.__rtmpSessionManager__!

export const rtmpSessionManager = managerInstance

if (shouldCreateManager) {
  globalThis.__rtmpSessionManager__ = managerInstance
  globalThis.__rtmpSessionManagerVersion__ = RTMP_SESSION_MANAGER_VERSION
}
