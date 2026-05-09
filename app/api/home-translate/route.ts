import { groq } from "@ai-sdk/groq"
import { generateText } from "ai"
import { NextResponse } from "next/server"

const TRANSLATION_MODEL = "llama-3.1-8b-instant"

export async function POST(request: Request) {
  if (!process.env.GROQ_API_KEY) {
    return NextResponse.json(
      { error: "GROQ_API_KEY is not configured." },
      { status: 500 }
    )
  }

  try {
    const body = (await request.json()) as { text?: unknown; context?: unknown }
    const transcript =
      typeof body.text === "string" ? body.text.trim() : ""
    const context =
      typeof body.context === "string" ? body.context.trim() : ""

    if (!transcript) {
      return NextResponse.json({ text: "" })
    }

    const { text } = await generateText({
      model: groq(TRANSLATION_MODEL),
      system:
        "Translate spoken Spanish transcript text into natural English. " +
        "Return only the English translation for the target text. Use context only for disambiguation. " +
        "Do not repeat, summarize, or translate the context by itself. Preserve names, brands, and technical terms. " +
        "Keep incomplete trailing phrases incomplete instead of inventing endings.",
      prompt: context
        ? `Recent context for meaning only:\n${context}\n\nTarget text to translate:\n${transcript}`
        : transcript,
    })

    return NextResponse.json({
      text: text.trim(),
      model: TRANSLATION_MODEL,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Groq text translation failed.",
      },
      { status: 500 }
    )
  }
}
