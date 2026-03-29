import { randomUUID } from "node:crypto"

import type { TranscriptEntry } from "@/components/transcriber-ui"

export type SharedSourceType = "microphone" | "livestream"
export type SharedSessionStatus = "active" | "ended"

export interface SharedSessionSnapshot {
  code: string
  createdAt: number
  entries: TranscriptEntry[]
  id: string
  sourceTitle?: string
  sourceType: SharedSourceType
  status: SharedSessionStatus
  viewerCount: number
}

type SharedSessionEvent =
  | { type: "snapshot"; snapshot: SharedSessionSnapshot }
  | { type: "entry"; entry: TranscriptEntry }
  | {
      type: "meta"
      sourceTitle?: string
      status: SharedSessionStatus
    }

interface SharedSession {
  code: string
  createdAt: number
  entries: TranscriptEntry[]
  hostToken: string
  id: string
  listeners: Set<(event: SharedSessionEvent) => void>
  sourceTitle?: string
  sourceType: SharedSourceType
  status: SharedSessionStatus
  updatedAt: number
}

const MAX_ENTRIES = 500
const SESSION_TTL_MS = 6 * 60 * 60 * 1000
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const CODE_LENGTH = 6

function generateCode() {
  let code = ""
  for (let index = 0; index < CODE_LENGTH; index++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}

class SharedSessionManager {
  private readonly sessions = new Map<string, SharedSession>()
  private readonly sessionsByCode = new Map<string, string>()

  private cleanupExpiredSessions() {
    const now = Date.now()

    for (const [id, session] of this.sessions.entries()) {
      if (session.listeners.size > 0) {
        continue
      }

      if (
        session.status === "ended" ||
        now - session.updatedAt > SESSION_TTL_MS
      ) {
        this.sessions.delete(id)
        this.sessionsByCode.delete(session.code)
      }
    }
  }

  private createSnapshot(session: SharedSession): SharedSessionSnapshot {
    return {
      code: session.code,
      createdAt: session.createdAt,
      entries: session.entries,
      id: session.id,
      sourceTitle: session.sourceTitle,
      sourceType: session.sourceType,
      status: session.status,
      viewerCount: session.listeners.size,
    }
  }

  private emit(session: SharedSession, event: SharedSessionEvent) {
    for (const listener of session.listeners) {
      listener(event)
    }
  }

  createSession({
    sourceTitle,
    sourceType,
  }: {
    sourceTitle?: string
    sourceType: SharedSourceType
  }) {
    this.cleanupExpiredSessions()

    let code = generateCode()
    while (this.sessionsByCode.has(code)) {
      code = generateCode()
    }

    const session: SharedSession = {
      code,
      createdAt: Date.now(),
      entries: [],
      hostToken: randomUUID(),
      id: randomUUID(),
      listeners: new Set(),
      sourceTitle,
      sourceType,
      status: "active",
      updatedAt: Date.now(),
    }

    this.sessions.set(session.id, session)
    this.sessionsByCode.set(session.code, session.id)

    return {
      hostToken: session.hostToken,
      snapshot: this.createSnapshot(session),
    }
  }

  getSessionById(id: string) {
    this.cleanupExpiredSessions()
    return this.sessions.get(id)
  }

  getSessionByCode(code: string) {
    this.cleanupExpiredSessions()
    const normalizedCode = code.trim().toUpperCase()
    const sessionId = this.sessionsByCode.get(normalizedCode)
    if (!sessionId) return undefined
    return this.sessions.get(sessionId)
  }

  getSnapshotByCode(code: string) {
    const session = this.getSessionByCode(code)
    if (!session) return undefined
    return this.createSnapshot(session)
  }

  getSnapshotById(id: string) {
    this.cleanupExpiredSessions()
    const session = this.sessions.get(id)
    if (!session) return undefined
    return this.createSnapshot(session)
  }

  subscribe(sessionId: string, listener: (event: SharedSessionEvent) => void) {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return null
    }

    session.listeners.add(listener)
    session.updatedAt = Date.now()
    listener({
      type: "snapshot",
      snapshot: this.createSnapshot(session),
    })
    this.emit(session, {
      type: "snapshot",
      snapshot: this.createSnapshot(session),
    })

    return () => {
      session.listeners.delete(listener)
      session.updatedAt = Date.now()
      this.emit(session, {
        type: "snapshot",
        snapshot: this.createSnapshot(session),
      })
      this.cleanupExpiredSessions()
    }
  }

  appendEntry({
    entry,
    hostToken,
    sessionId,
  }: {
    entry: TranscriptEntry
    hostToken: string
    sessionId: string
  }) {
    const session = this.sessions.get(sessionId)
    if (!session || session.hostToken !== hostToken) {
      return false
    }

    session.entries = [...session.entries, entry].slice(-MAX_ENTRIES)
    session.updatedAt = Date.now()
    this.emit(session, { type: "entry", entry })
    return true
  }

  syncSession({
    entries,
    hostToken,
    sessionId,
    sourceTitle,
  }: {
    entries: TranscriptEntry[]
    hostToken: string
    sessionId: string
    sourceTitle?: string
  }) {
    const session = this.sessions.get(sessionId)
    if (!session || session.hostToken !== hostToken) {
      return false
    }

    session.entries = entries.slice(-MAX_ENTRIES)
    session.sourceTitle = sourceTitle
    session.updatedAt = Date.now()
    this.emit(session, {
      type: "snapshot",
      snapshot: this.createSnapshot(session),
    })
    return true
  }

  updateMetadata({
    hostToken,
    sessionId,
    sourceTitle,
  }: {
    hostToken: string
    sessionId: string
    sourceTitle?: string
  }) {
    const session = this.sessions.get(sessionId)
    if (!session || session.hostToken !== hostToken) {
      return false
    }

    session.sourceTitle = sourceTitle
    session.updatedAt = Date.now()
    this.emit(session, {
      type: "meta",
      sourceTitle: session.sourceTitle,
      status: session.status,
    })
    return true
  }

  endSession({
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

    session.status = "ended"
    session.updatedAt = Date.now()
    this.emit(session, {
      type: "meta",
      sourceTitle: session.sourceTitle,
      status: session.status,
    })
    return true
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __sharedSessionManager__: SharedSessionManager | undefined
}

export const sharedSessionManager =
  globalThis.__sharedSessionManager__ ?? new SharedSessionManager()

if (!globalThis.__sharedSessionManager__) {
  globalThis.__sharedSessionManager__ = sharedSessionManager
}
