const GROQ_TRANSLATION_URL = "https://api.groq.com/openai/v1/audio/translations"
export const GROQ_TRANSLATION_MODEL = "whisper-large-v3"

export interface GroqTranslationPayload {
  segments: unknown[]
  text: string
}

export async function translateAudioChunk({
  audioFile,
  context,
}: {
  audioFile: File
  context?: string
}): Promise<GroqTranslationPayload> {
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

  const prompt = context
    ? `Continue the same English translation style and narrative continuity as this recent context: ${context}`
    : "Translate all spoken content to natural English only. Preserve proper nouns, names, brands, and technical terms when they are clear."

  upstreamFormData.append("prompt", prompt)

  const upstreamResponse = await fetch(GROQ_TRANSLATION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: upstreamFormData,
  })

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text()
    throw new Error(
      `Groq translation failed: ${upstreamResponse.status} ${errorText}`
    )
  }

  const payload = await upstreamResponse.json()

  return {
    text: typeof payload.text === "string" ? payload.text : "",
    segments: Array.isArray(payload.segments) ? payload.segments : [],
  }
}
