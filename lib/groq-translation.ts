import { normalizeWhitespace } from "@/lib/transcript-text-utils"

const GROQ_TRANSLATION_URL = "https://api.groq.com/openai/v1/audio/translations"
export const GROQ_TRANSLATION_MODEL = "whisper-large-v3"
const MAX_GROQ_CONTEXT_CHARS = 320
const MAX_NO_SPEECH_PROB = 0.6
const MIN_AVG_LOGPROB = -0.9
const MIN_COMPRESSION_RATIO = 0.6
const MAX_COMPRESSION_RATIO = 2.8
const LOW_CONFIDENCE_NO_SPEECH_PROB = 0.28
const LOW_CONFIDENCE_AVG_LOGPROB = -0.45
const LOW_CONFIDENCE_MIN_COMPRESSION_RATIO = 0.75
const LOW_CONFIDENCE_MAX_COMPRESSION_RATIO = 2.4
const GROQ_TRANSLATION_TIMEOUT_MS = 45_000

export interface GroqSegment {
  avg_logprob?: number
  compression_ratio?: number
  end?: number
  no_speech_prob?: number
  start?: number
  text?: string
}

export interface GroqTranslationPayload {
  segments: GroqSegment[]
  text: string
}

export interface GroqTranslationMeta {
  cfRay?: string
  contextChars: number
  contextTruncated: boolean
  groqMs: number
  promptChars: number
  xGroqRegion?: string
}

export interface GroqTranslationAssessment {
  lowConfidence: boolean
  text: string
}

function buildGroqPromptContext(context?: string) {
  const normalizedContext = normalizeWhitespace(context ?? "")
  if (!normalizedContext) {
    return {
      contextChars: 0,
      contextTruncated: false,
      value: "",
    }
  }

  if (normalizedContext.length <= MAX_GROQ_CONTEXT_CHARS) {
    return {
      contextChars: normalizedContext.length,
      contextTruncated: false,
      value: normalizedContext,
    }
  }

  return {
    contextChars: MAX_GROQ_CONTEXT_CHARS,
    contextTruncated: true,
    value: normalizedContext.slice(-MAX_GROQ_CONTEXT_CHARS),
  }
}

function shouldKeepSegment(segment: GroqSegment, text: string): boolean {
  if (!text) {
    return false
  }

  if (
    typeof segment.no_speech_prob === "number" &&
    segment.no_speech_prob > MAX_NO_SPEECH_PROB
  ) {
    return false
  }

  if (
    typeof segment.avg_logprob === "number" &&
    segment.avg_logprob < MIN_AVG_LOGPROB
  ) {
    return false
  }

  if (
    typeof segment.compression_ratio === "number" &&
    (segment.compression_ratio < MIN_COMPRESSION_RATIO ||
      segment.compression_ratio > MAX_COMPRESSION_RATIO)
  ) {
    return false
  }

  return true
}

function isLowConfidenceSegment(segment: GroqSegment): boolean {
  if (
    typeof segment.no_speech_prob === "number" &&
    segment.no_speech_prob >= LOW_CONFIDENCE_NO_SPEECH_PROB
  ) {
    return true
  }

  if (
    typeof segment.avg_logprob === "number" &&
    segment.avg_logprob <= LOW_CONFIDENCE_AVG_LOGPROB
  ) {
    return true
  }

  if (
    typeof segment.compression_ratio === "number" &&
    (segment.compression_ratio <= LOW_CONFIDENCE_MIN_COMPRESSION_RATIO ||
      segment.compression_ratio >= LOW_CONFIDENCE_MAX_COMPRESSION_RATIO)
  ) {
    return true
  }

  return false
}

export function assessGroqTranslation(
  payload: GroqTranslationPayload
): GroqTranslationAssessment {
  const topLevelText = normalizeWhitespace(payload.text)
  const stableSegments = payload.segments
    .map((segment) => {
      const text = normalizeWhitespace(typeof segment.text === "string" ? segment.text : "")
      return shouldKeepSegment(segment, text) ? { lowConfidence: isLowConfidenceSegment(segment), text } : null
    })
    .filter((segment): segment is { lowConfidence: boolean; text: string } => Boolean(segment))

  if (stableSegments.length === 0) {
    return {
      lowConfidence: false,
      text: topLevelText,
    }
  }

  return {
    lowConfidence: stableSegments.some((segment) => segment.lowConfidence),
    text: topLevelText || normalizeWhitespace(stableSegments.map((segment) => segment.text).join(" ")),
  }
}

export async function translateAudioChunk({
  audioFile,
  context,
}: {
  audioFile: File
  context?: string
}): Promise<{ meta: GroqTranslationMeta; payload: GroqTranslationPayload }> {
  const apiKey = process.env.GROQ_API_KEY

  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured.")
  }

  const upstreamFormData = new FormData()
  upstreamFormData.append("file", audioFile, audioFile.name || "segment.wav")
  upstreamFormData.append("model", GROQ_TRANSLATION_MODEL)
  upstreamFormData.append("language", "en")
  upstreamFormData.append("temperature", "0")
  upstreamFormData.append("response_format", "verbose_json")

  const promptBase =
    "Spanish Christian sermon. Natural English translation. Preserve proper nouns, Bible references, and theological terms with clear spelling."
  const preparedContext = buildGroqPromptContext(context)
  const prompt = preparedContext.value
    ? `${promptBase} Keep continuity with this recent English translation context: ${preparedContext.value}`
    : promptBase

  upstreamFormData.append("prompt", prompt)

  const abortController = new AbortController()
  const timeout = setTimeout(() => {
    abortController.abort(
      new Error("Groq translation timed out before the upstream request completed.")
    )
  }, GROQ_TRANSLATION_TIMEOUT_MS)

  let upstreamResponse: Response

  try {
    const groqStartedAt = performance.now()
    upstreamResponse = await fetch(GROQ_TRANSLATION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: upstreamFormData,
      signal: abortController.signal,
    })
    const groqMs = performance.now() - groqStartedAt

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text()
      throw new Error(
        `Groq translation failed: ${upstreamResponse.status} ${errorText}`
      )
    }

    const payload = await upstreamResponse.json()

    return {
      meta: {
        cfRay: upstreamResponse.headers.get("cf-ray") ?? undefined,
        contextChars: preparedContext.contextChars,
        contextTruncated: preparedContext.contextTruncated,
        groqMs,
        promptChars: prompt.length,
        xGroqRegion: upstreamResponse.headers.get("x-groq-region") ?? undefined,
      },
      payload: {
        text: typeof payload.text === "string" ? payload.text : "",
        segments: Array.isArray(payload.segments)
          ? (payload.segments as GroqSegment[])
          : [],
      },
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error("Groq translation timed out.")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
