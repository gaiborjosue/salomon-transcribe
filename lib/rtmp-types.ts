import type { TranscriptEntry } from "@/components/transcriber-ui"

export type RtmpSessionStatus =
  | "connecting"
  | "connected"
  | "paused"
  | "transcribing"
  | "disconnected"
  | "error"

export interface RtmpSessionSnapshot {
  createdAt: number
  entries: TranscriptEntry[]
  error?: string
  id: string
  publishUrl: string
  sourceTitle?: string
  status: RtmpSessionStatus
  streamKey: string
}
