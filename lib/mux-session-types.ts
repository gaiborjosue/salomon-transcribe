import type { TranscriptEntry } from "@/components/transcriber-ui"

export type MuxProcessingStatus =
  | "connecting"
  | "connected"
  | "paused"
  | "transcribing"
  | "disconnected"
  | "error"

export type MuxLiveStatus = "active" | "deleted" | "disabled" | "idle"

export interface MuxPerfTrace {
  cfRay?: string
  classifierDecision?: "mixed" | "music" | "speech"
  contextChars?: number
  contextTruncated?: boolean
  fetchRoundTripMs?: number
  groqMs?: number
  id: string
  lowConfidence?: boolean
  musicScore?: number
  networkOverheadMs?: number
  promptChars?: number
  queueWaitMs?: number
  responseSkipped: boolean
  segmentDurationMs: number
  serverClassifierMs?: number
  serverTotalMs?: number
  source: "mux-hls"
  speechScore?: number
  status: "completed" | "failed" | "skipped"
  textLength?: number
  topLabel?: string
  wavEncodeMs?: number
  workerTotalMs: number
  xGroqRegion?: string
}

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
