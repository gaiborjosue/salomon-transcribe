import type { TranscriptEntry } from "@/lib/transcript-types"

export type LivestreamSessionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "paused"
  | "transcribing"
  | "disconnected"
  | "error"

export interface LivestreamSessionSnapshot {
  error?: string
  id: string
  segments: TranscriptEntry[]
  sourceTitle?: string
  status: LivestreamSessionStatus
  streamUrl: string
}
