import type { RealtimeResult, RealtimeToken, SttSessionConfig } from "@soniox/node"

import type { TranscriptCaption } from "@/lib/transcript-types"

export const SONIOX_STREAM_ROTATE_AFTER_MS = 295 * 60 * 1_000

export const SONIOX_TRANSLATION_CONFIG = {
  model: "stt-rt-v6",
  language_hints: ["es"],
  language_hints_strict: true,
  enable_language_identification: true,
  enable_speaker_diarization: true,
  enable_endpoint_detection: true,
  translation: { type: "one_way", target_language: "en" },
} satisfies SttSessionConfig

function isEnglishTranslation(token: RealtimeToken) {
  return (
    token.translation_status === "translation" &&
    (token.language === undefined || token.language === "en") &&
    (token.source_language === undefined || token.source_language === "es")
  )
}

function appendToken(captions: TranscriptCaption[], text: string, speakerId?: string) {
  const previous = captions.at(-1)
  if (previous && previous.speakerId === speakerId) {
    previous.text += text
  } else {
    captions.push({ speakerId, text })
  }
}

function trimCaptions(captions: TranscriptCaption[]) {
  return captions.flatMap(({ speakerId, text }) => {
    const content = text.trim()
    return content ? [{ speakerId, text: content }] : []
  })
}

export class SonioxTranslationBuffer {
  private finalCaptions: TranscriptCaption[] = []
  private readonly speakers = new Map<string, string>()

  resetSpeakers() {
    this.speakers.clear()
  }

  update({ tokens }: RealtimeResult) {
    const partialTokens: TranscriptCaption[] = []

    for (const token of tokens) {
      if (!isEnglishTranslation(token) || !token.text) continue

      const speakerId = token.speaker ? this.getSpeakerId(token.speaker) : undefined
      if (token.is_final) {
        appendToken(this.finalCaptions, token.text, speakerId)
      } else {
        appendToken(partialTokens, token.text, speakerId)
      }
    }

    const preview = this.finalCaptions.map((caption) => ({ ...caption }))
    for (const { speakerId, text } of partialTokens) {
      appendToken(preview, text, speakerId)
    }
    return trimCaptions(preview)
  }

  takeFinal() {
    const captions = trimCaptions(this.finalCaptions)
    this.finalCaptions = []
    return captions
  }

  private getSpeakerId(label: string) {
    const existing = this.speakers.get(label)
    if (existing) return existing

    const speakerId = globalThis.crypto.randomUUID()
    this.speakers.set(label, speakerId)
    return speakerId
  }
}
