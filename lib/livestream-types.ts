export type LivestreamMode = "conversation" | "sermon"

export type LivestreamSessionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "paused"
  | "transcribing"
  | "disconnected"
  | "error"

export interface LivestreamTranscriptEntry {
  id: string
  lowConfidence?: boolean
  text: string
  timestampMs: number
}

export interface LivestreamSessionSnapshot {
  error?: string
  id: string
  segments: LivestreamTranscriptEntry[]
  sourceTitle?: string
  status: LivestreamSessionStatus
  streamUrl: string
}
