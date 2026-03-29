import { NextResponse } from "next/server"
import {
  audioContentClassifier,
  extractPcm16MonoFromWav,
  shouldSkipForMusic,
} from "@/lib/audio-content-classifier"
import { GROQ_TRANSLATION_MODEL, translateAudioChunk } from "@/lib/groq-translation"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const requestStartedAt = performance.now()
    const incomingFormData = await request.formData()
    const audioFile = incomingFormData.get("audio")
    const contextValue = incomingFormData.get("context")
    const skipServerClassificationValue = incomingFormData.get(
      "skipServerClassification"
    )
    const context =
      typeof contextValue === "string" ? contextValue.trim() : ""
    const skipServerClassification =
      skipServerClassificationValue === "true"

    if (!(audioFile instanceof File)) {
      return NextResponse.json(
        { error: "Missing audio file upload." },
        { status: 400 }
      )
    }

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
            const totalMs = performance.now() - requestStartedAt
            console.info(
              `[GroqAPI][Timing] skipped=music classifier=${classifierMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms top=${classification.topLabel} speech=${classification.speechScore.toFixed(3)} music=${classification.musicScore.toFixed(3)}`
            )

            return NextResponse.json({
              metrics: {
                classifierMs,
                decision: classification.decision,
                musicScore: classification.musicScore,
                speechScore: classification.speechScore,
                topLabel: classification.topLabel,
                totalMs,
              },
              segments: [],
              skipped: true,
              text: "",
              x_groq_model: GROQ_TRANSLATION_MODEL,
            })
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
    const totalMs = performance.now() - requestStartedAt

    console.info(
      `[GroqAPI][Timing] skipped=false classifier=${classifierMs?.toFixed(1) ?? "n/a"}ms groq=${groqMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms${classification ? ` top=${classification.topLabel} speech=${classification.speechScore.toFixed(3)} music=${classification.musicScore.toFixed(3)}` : ""}`
    )

    return NextResponse.json({
      metrics: {
        classifierMs,
        decision: classification?.decision,
        groqMs,
        musicScore: classification?.musicScore,
        speechScore: classification?.speechScore,
        topLabel: classification?.topLabel,
        totalMs,
      },
      text: payload.text,
      segments: payload.segments,
      skipped: false,
      x_groq_model: GROQ_TRANSLATION_MODEL,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Groq translation failed.",
      },
      { status: 500 }
    )
  }
}
