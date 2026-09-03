import type { TranscriptEntry } from "@/components/transcriber-ui"

export type TranscriptSessionSource = "livestream" | "microphone" | "mux" | "rtmp"

export interface TranscriptSessionSummary {
  archivedAt?: number
  endedAt: number
  entryCount: number
  id: string
  previewText?: string
  sourceTitle?: string
  sourceType: TranscriptSessionSource
  startedAt: number
  title: string
  updatedAt: number
}

export interface TranscriptSessionDetail extends TranscriptSessionSummary {
  entries: TranscriptEntry[]
}

export interface TranscriptSessionListPayload {
  active: TranscriptSessionSummary[]
  archived: TranscriptSessionSummary[]
}
