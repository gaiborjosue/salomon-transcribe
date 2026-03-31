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
  viewerCount: number
}

const MAX_ENTRIES = 500
const SESSION_TTL_MS = 6 * 60 * 60 * 1000
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const CODE_LENGTH = 6
export const SHARE_CODE_PREFIX = "SAL"

function generateRawCode() {
  let code = ""
  for (let index = 0; index < CODE_LENGTH; index++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}

export function formatShareCode(input: string) {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "")
  let body = compact

  if (body.startsWith(SHARE_CODE_PREFIX)) {
    body = body.slice(SHARE_CODE_PREFIX.length)
  }

  body = body.slice(0, CODE_LENGTH)
  return body ? `${SHARE_CODE_PREFIX}-${body}` : `${SHARE_CODE_PREFIX}-`
}

export function normalizeShareCode(input: string) {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "")
  const body = compact.startsWith(SHARE_CODE_PREFIX)
    ? compact.slice(SHARE_CODE_PREFIX.length)
    : compact

  if (body.length !== CODE_LENGTH) {
    return null
  }

  return `${SHARE_CODE_PREFIX}-${body}`
}

function generateCode() {
  return `${SHARE_CODE_PREFIX}-${generateRawCode()}`
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
      viewerCount: session.viewerCount,
    }
  }

  private emit(session: SharedSession, event: SharedSessionEvent) {
    for (const listener of session.listeners) {
      listener(event)
    }
  }

  createSession({
    code,
    createdAt,
    hostToken,
    id,
    initialEntries,
    sourceTitle,
    sourceType,
    status,
  }: {
    code?: string
    createdAt?: number
    hostToken?: string
    id?: string
    initialEntries?: TranscriptEntry[]
    sourceTitle?: string
    sourceType: SharedSourceType
    status?: SharedSessionStatus
  }) {
    this.cleanupExpiredSessions()

    let resolvedCode = code ?? generateCode()
    while (this.sessionsByCode.has(resolvedCode)) {
      if (code) {
        throw new Error("Shared session code already exists.")
      }
      resolvedCode = generateCode()
    }

    const sessionId = id ?? randomUUID()
    if (this.sessions.has(sessionId)) {
      throw new Error("Shared session id already exists.")
    }

    const session: SharedSession = {
      code: resolvedCode,
      createdAt: createdAt ?? Date.now(),
      entries: (initialEntries ?? []).slice(-MAX_ENTRIES),
      hostToken: hostToken ?? randomUUID(),
      id: sessionId,
      listeners: new Set(),
      sourceTitle,
      sourceType,
      status: status ?? "active",
      updatedAt: Date.now(),
      viewerCount: 0,
    }

    this.sessions.set(session.id, session)
    this.sessionsByCode.set(session.code, session.id)

    return {
      hostToken: session.hostToken,
      snapshot: this.createSnapshot(session),
    }
  }

  ensureSession({
    code,
    createdAt,
    entries,
    hostToken,
    id,
    sourceTitle,
    sourceType,
    status,
  }: {
    code: string
    createdAt?: number
    entries?: TranscriptEntry[]
    hostToken: string
    id: string
    sourceTitle?: string
    sourceType: SharedSourceType
    status?: SharedSessionStatus
  }) {
    this.cleanupExpiredSessions()

    const existing = this.sessions.get(id)
    if (existing) {
      return {
        hostToken: existing.hostToken,
        snapshot: this.createSnapshot(existing),
      }
    }

    return this.createSession({
      code,
      createdAt,
      hostToken,
      id,
      initialEntries: entries,
      sourceTitle,
      sourceType,
      status,
    })
  }

  getSessionById(id: string) {
    this.cleanupExpiredSessions()
    return this.sessions.get(id)
  }

  getSessionByCode(code: string) {
    this.cleanupExpiredSessions()
    const normalizedCode = normalizeShareCode(code)
    if (!normalizedCode) return undefined
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

  subscribe(
    sessionId: string,
    listener: (event: SharedSessionEvent) => void,
    options?: { countAsViewer?: boolean }
  ) {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return null
    }

    const countAsViewer = options?.countAsViewer !== false
    session.listeners.add(listener)
    if (countAsViewer) {
      session.viewerCount += 1
    }
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
      if (countAsViewer) {
        session.viewerCount = Math.max(0, session.viewerCount - 1)
      }
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
  // eslint-disable-next-line no-var
  var __sharedSessionManagerVersion__: number | undefined
}

const SHARED_SESSION_MANAGER_VERSION = 2

const shouldCreateManager =
  !globalThis.__sharedSessionManager__ ||
  globalThis.__sharedSessionManagerVersion__ !== SHARED_SESSION_MANAGER_VERSION ||
  typeof globalThis.__sharedSessionManager__.ensureSession !== "function"

const managerInstance: SharedSessionManager = shouldCreateManager
  ? new SharedSessionManager()
  : globalThis.__sharedSessionManager__!

export const sharedSessionManager = managerInstance

if (shouldCreateManager) {
  globalThis.__sharedSessionManager__ = managerInstance
  globalThis.__sharedSessionManagerVersion__ = SHARED_SESSION_MANAGER_VERSION
}
