import { NextResponse } from "next/server"
import { processAudioTranslation } from "@/lib/process-audio-translation"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
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

    const result = await processAudioTranslation({
      audioFile,
      context,
      skipServerClassification,
    })

    console.info(
      `[GroqAPI][Timing] skipped=${result.skipped ? "true" : "false"} classifier=${result.metrics.classifierMs?.toFixed(1) ?? "n/a"}ms groq=${result.metrics.groqMs?.toFixed(1) ?? "n/a"}ms total=${result.metrics.totalMs.toFixed(1)}ms${result.metrics.topLabel ? ` top=${result.metrics.topLabel}` : ""}${typeof result.metrics.speechScore === "number" ? ` speech=${result.metrics.speechScore.toFixed(3)}` : ""}${typeof result.metrics.musicScore === "number" ? ` music=${result.metrics.musicScore.toFixed(3)}` : ""}`
    )

    return NextResponse.json({
      metrics: result.metrics,
      text: result.payload.text,
      segments: result.payload.segments,
      skipped: result.skipped,
      x_groq_model: result.xGroqModel,
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
