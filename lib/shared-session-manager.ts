import { randomUUID } from "node:crypto"

import type { TranscriptEntry } from "@/components/transcriber-ui"
import prisma from "@/lib/prisma"
import { normalizeShareCode, SHARE_CODE_PREFIX } from "@/lib/share-code-utils"

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
function generateRawCode() {
  let code = ""
  for (let index = 0; index < CODE_LENGTH; index++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
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

      if (session.status === "ended" || now - session.updatedAt > SESSION_TTL_MS) {
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

  private async loadRecentEntries(sessionId: string) {
    const rows = await prisma.sharedSessionEntry.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
      take: MAX_ENTRIES,
    })

    return rows.reverse().map((entry) => this.toEntry(entry))
  }

  private async hydrateById(id: string) {
    this.cleanupExpiredSessions()

    const existing = this.sessions.get(id)
    if (existing) {
      return existing
    }

    const session = await prisma.sharedSession.findUnique({
      where: { id },
    })

    if (!session) {
      return null
    }

    const hydrated: SharedSession = {
      code: session.code,
      createdAt: session.createdAt.getTime(),
      entries: await this.loadRecentEntries(session.id),
      hostToken: session.hostToken,
      id: session.id,
      listeners: new Set(),
      sourceTitle: session.sourceTitle ?? undefined,
      sourceType: session.sourceType,
      status: session.status,
      updatedAt: session.updatedAt.getTime(),
      viewerCount: 0,
    }

    this.sessions.set(hydrated.id, hydrated)
    this.sessionsByCode.set(hydrated.code, hydrated.id)
    return hydrated
  }

  private async hydrateByCode(code: string) {
    this.cleanupExpiredSessions()

    const normalizedCode = normalizeShareCode(code)
    if (!normalizedCode) {
      return null
    }

    const existingId = this.sessionsByCode.get(normalizedCode)
    if (existingId) {
      return this.hydrateById(existingId)
    }

    const session = await prisma.sharedSession.findUnique({
      where: { code: normalizedCode },
      select: { id: true },
    })

    if (!session) {
      return null
    }

    return this.hydrateById(session.id)
  }

  async createSession({
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
    if (!code) {
      while (
        this.sessionsByCode.has(resolvedCode) ||
        (await prisma.sharedSession.findUnique({
          where: { code: resolvedCode },
          select: { id: true },
        }))
      ) {
        resolvedCode = generateCode()
      }
    }

    const sessionId = id ?? randomUUID()
    const nextHostToken = hostToken ?? randomUUID()
    const nextCreatedAt = createdAt ?? Date.now()
    const nextEntries = (initialEntries ?? []).slice(-MAX_ENTRIES)
    const nextStatus = status ?? "active"

    const persisted = await prisma.sharedSession.create({
      data: {
        code: resolvedCode,
        createdAt: new Date(nextCreatedAt),
        endedAt: nextStatus === "ended" ? new Date(nextCreatedAt) : null,
        hostToken: nextHostToken,
        id: sessionId,
        sourceTitle,
        sourceType,
        status: nextStatus,
        entries: nextEntries.length
          ? {
              create: nextEntries.map((entry) => ({
                lowConfidence: entry.lowConfidence,
                text: entry.text,
                timestampMs: entry.timestampMs,
              })),
            }
          : undefined,
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

    const session: SharedSession = {
      code: persisted.code,
      createdAt: persisted.createdAt.getTime(),
      entries: persisted.entries.map((entry) => this.toEntry(entry)),
      hostToken: persisted.hostToken,
      id: persisted.id,
      listeners: new Set(),
      sourceTitle: persisted.sourceTitle ?? undefined,
      sourceType: persisted.sourceType,
      status: persisted.status,
      updatedAt: persisted.updatedAt.getTime(),
      viewerCount: 0,
    }

    this.sessions.set(session.id, session)
    this.sessionsByCode.set(session.code, session.id)

    return {
      hostToken: session.hostToken,
      snapshot: this.createSnapshot(session),
    }
  }

  async ensureSession({
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

    const existing = await this.hydrateById(id)
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

  async ensureSnapshotById(id: string) {
    const session = await this.hydrateById(id)
    if (!session) {
      return null
    }

    return this.createSnapshot(session)
  }

  async ensureSnapshotByCode(code: string) {
    const session = await this.hydrateByCode(code)
    if (!session) {
      return null
    }

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

  async appendEntry({
    entry,
    hostToken,
    sessionId,
  }: {
    entry: TranscriptEntry
    hostToken: string
    sessionId: string
  }) {
    const session = await this.hydrateById(sessionId)
    if (!session || session.hostToken !== hostToken) {
      return false
    }

    await prisma.$transaction(async (tx) => {
      await tx.sharedSessionEntry.create({
        data: {
          lowConfidence: entry.lowConfidence,
          sessionId,
          text: entry.text,
          timestampMs: entry.timestampMs,
        },
      })

      await tx.sharedSession.update({
        where: { id: sessionId },
        data: {
          updatedAt: new Date(),
        },
      })
    })

    session.entries = [...session.entries, entry].slice(-MAX_ENTRIES)
    session.updatedAt = Date.now()
    this.emit(session, { type: "entry", entry })
    return true
  }

  async syncSession({
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
    const session = await this.hydrateById(sessionId)
    if (!session || session.hostToken !== hostToken) {
      return false
    }

    const nextEntries = entries.slice(-MAX_ENTRIES)

    await prisma.$transaction(async (tx) => {
      await tx.sharedSession.update({
        where: { id: sessionId },
        data: {
          sourceTitle,
        },
      })

      await tx.sharedSessionEntry.deleteMany({
        where: { sessionId },
      })

      if (nextEntries.length > 0) {
        await tx.sharedSessionEntry.createMany({
          data: nextEntries.map((entry) => ({
            lowConfidence: entry.lowConfidence,
            sessionId,
            text: entry.text,
            timestampMs: entry.timestampMs,
          })),
        })
      }
    })

    session.entries = nextEntries
    session.sourceTitle = sourceTitle
    session.updatedAt = Date.now()
    this.emit(session, {
      type: "snapshot",
      snapshot: this.createSnapshot(session),
    })
    return true
  }

  async updateMetadata({
    hostToken,
    sessionId,
    sourceTitle,
  }: {
    hostToken: string
    sessionId: string
    sourceTitle?: string
  }) {
    const session = await this.hydrateById(sessionId)
    if (!session || session.hostToken !== hostToken) {
      return false
    }

    await prisma.sharedSession.update({
      where: { id: sessionId },
      data: {
        sourceTitle,
      },
    })

    session.sourceTitle = sourceTitle
    session.updatedAt = Date.now()
    this.emit(session, {
      type: "meta",
      sourceTitle: session.sourceTitle,
      status: session.status,
    })
    return true
  }

  async endSession({
    hostToken,
    sessionId,
  }: {
    hostToken: string
    sessionId: string
  }) {
    const session = await this.hydrateById(sessionId)
    if (!session || session.hostToken !== hostToken) {
      return false
    }

    await prisma.sharedSession.update({
      where: { id: sessionId },
      data: {
        endedAt: new Date(),
        status: "ended",
      },
    })

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

const SHARED_SESSION_MANAGER_VERSION = 4

const shouldCreateManager =
  !globalThis.__sharedSessionManager__ ||
  globalThis.__sharedSessionManagerVersion__ !== SHARED_SESSION_MANAGER_VERSION ||
  typeof globalThis.__sharedSessionManager__.ensureSession !== "function" ||
  typeof globalThis.__sharedSessionManager__.ensureSnapshotById !== "function" ||
  typeof globalThis.__sharedSessionManager__.ensureSnapshotByCode !== "function"

const managerInstance: SharedSessionManager = shouldCreateManager
  ? new SharedSessionManager()
  : globalThis.__sharedSessionManager__!

export const sharedSessionManager = managerInstance

if (shouldCreateManager) {
  globalThis.__sharedSessionManager__ = managerInstance
  globalThis.__sharedSessionManagerVersion__ = SHARED_SESSION_MANAGER_VERSION
}
