import type { TranscriptEntry } from "@/components/transcriber-ui"

export type MuxProcessingStatus =
  | "connecting"
  | "connected"
  | "paused"
  | "transcribing"
  | "disconnected"
  | "error"

export type MuxLiveStatus = "active" | "deleted" | "disabled" | "idle"

export interface MuxSessionSnapshot {
  audioOnly: boolean
  createdAt: number
  dashboardUrl?: string
  entries: TranscriptEntry[]
  error?: string
  id: string
  muxStatus: MuxLiveStatus
  playbackId: string | null
  playbackUrl: string | null
  publishUrl: string
  sharedSessionCode: string
  sharedSessionId: string
  status: MuxProcessingStatus
  streamKey: string
  updatedAt: number
}

export interface MuxSessionSummary {
  audioOnly: boolean
  dashboardUrl?: string
  id: string
  muxStatus: MuxLiveStatus
  playbackId: string | null
  publishUrl: string
  sharedSessionCode: string
  sharedSessionId: string
  status: MuxProcessingStatus
  streamKey: string
  updatedAt: number
}
