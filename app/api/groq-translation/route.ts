import { NextResponse } from "next/server"
import { GROQ_TRANSLATION_MODEL, translateAudioChunk } from "@/lib/groq-translation"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const incomingFormData = await request.formData()
    const audioFile = incomingFormData.get("audio")
    const contextValue = incomingFormData.get("context")
    const context =
      typeof contextValue === "string" ? contextValue.trim() : ""

    if (!(audioFile instanceof File)) {
      return NextResponse.json(
        { error: "Missing audio file upload." },
        { status: 400 }
      )
    }

    const payload = await translateAudioChunk({
      audioFile,
      context,
    })

    return NextResponse.json({
      text: payload.text,
      segments: payload.segments,
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
