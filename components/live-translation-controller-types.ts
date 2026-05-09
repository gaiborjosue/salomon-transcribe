export type MicControllerStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "paused"
  | "transcribing"
  | "disconnected"
  | "error"

export type LivestreamControllerStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "paused"
  | "transcribing"
  | "disconnected"
  | "error"

export type MicrophoneControllerHandle = {
  clearTranscripts: () => void
  connect: (options: {
    languageCode?: string
    microphone?: {
      autoGainControl?: boolean
      echoCancellation?: boolean
      noiseSuppression?: boolean
    }
    targetLanguage?: string
  }) => Promise<void>
  disconnect: () => void
  pause: () => Promise<void>
  resume: () => Promise<void>
}

export type LivestreamControllerHandle = {
  connect: (options: {
    streamUrl: string
    transcriptionMode: "conversation" | "sermon"
  }) => Promise<void>
  disconnect: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  sessionId: string | null
}
