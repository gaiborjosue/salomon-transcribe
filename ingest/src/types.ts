import type { AudioTranslationMetrics } from "@/lib/process-audio-translation"

export interface RtmpSessionPayload {
  appBaseUrl: string
  ingestToken: string
  sessionId: string
  streamKey: string
}

export interface MuxSessionPayload {
  appBaseUrl: string
  ingestToken: string
  playbackUrl: string
  sessionId: string
}

export type SessionKind = "mux" | "rtmp"

export type ManagedSession = {
  start: () => void | Promise<void>
  stop: (options?: { notifyApp?: boolean }) => Promise<void>
}

export class AppControlError extends Error {
  readonly alreadyCounted = true
}

export interface QueuedChunk {
  audio: Buffer
  id: string
  queuedAt: number
  segmentDurationMs: number
}

export interface ChunkRoutePayload {
  lowConfidence?: boolean
  metrics?: AudioTranslationMetrics
  paused?: boolean
  skipped?: boolean
  text?: string
}

export interface StatusRoutePayload {
  currentMuxStatus?: string
  currentStatus?: string
  ok?: boolean
}
