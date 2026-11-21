export interface TranscriptCaption {
  speakerId?: string
  text: string
}

export interface TranscriptEntry extends TranscriptCaption {
  id: string
  lowConfidence?: boolean
  timestampMs: number
}

export function parseTranscriptSpeakerId(value: unknown) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined
}
