import {
  audioContentClassifier,
  extractPcm16MonoFromWav,
  shouldSkipForMusic,
} from "@/lib/audio-content-classifier"
import {
  GROQ_TRANSLATION_MODEL,
  type GroqTranslationPayload,
  translateAudioChunk,
} from "@/lib/groq-translation"

export interface AudioTranslationMetrics {
  classifierMs?: number
  decision?: "mixed" | "music" | "speech"
  groqMs?: number
  musicScore?: number
  speechScore?: number
  topLabel?: string
  totalMs: number
}

export interface ProcessAudioTranslationResult {
  metrics: AudioTranslationMetrics
  payload: GroqTranslationPayload
  skipped: boolean
  xGroqModel: string
}

export async function processAudioTranslation({
  audioFile,
  context,
  skipServerClassification = false,
}: {
  audioFile: File
  context?: string
  skipServerClassification?: boolean
}): Promise<ProcessAudioTranslationResult> {
  const requestStartedAt = performance.now()

  let classification:
    | Awaited<ReturnType<typeof audioContentClassifier.classifyPcm16>>
    | undefined
  let classifierMs: number | undefined

  if (!skipServerClassification) {
    try {
      const wavBuffer = Buffer.from(await audioFile.arrayBuffer())
      const pcm = extractPcm16MonoFromWav(wavBuffer)
      if (pcm) {
        const classifyStartedAt = performance.now()
        classification = await audioContentClassifier.classifyPcm16(
          pcm.data,
          pcm.sampleRate
        )
        classifierMs = performance.now() - classifyStartedAt

        if (shouldSkipForMusic(classification)) {
          return {
            metrics: {
              classifierMs,
              decision: classification.decision,
              musicScore: classification.musicScore,
              speechScore: classification.speechScore,
              topLabel: classification.topLabel,
              totalMs: performance.now() - requestStartedAt,
            },
            payload: {
              segments: [],
              text: "",
            },
            skipped: true,
            xGroqModel: GROQ_TRANSLATION_MODEL,
          }
        }
      }
    } catch {
      // If local classification fails, continue with normal translation.
    }
  }

  const groqStartedAt = performance.now()
  const payload = await translateAudioChunk({
    audioFile,
    context,
  })
  const groqMs = performance.now() - groqStartedAt

  return {
    metrics: {
      classifierMs,
      decision: classification?.decision,
      groqMs,
      musicScore: classification?.musicScore,
      speechScore: classification?.speechScore,
      topLabel: classification?.topLabel,
      totalMs: performance.now() - requestStartedAt,
    },
    payload,
    skipped: false,
    xGroqModel: GROQ_TRANSLATION_MODEL,
  }
}
