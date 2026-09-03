import { NextResponse } from "next/server"

import { assessGroqTranslation } from "@/lib/groq-translation"
import { muxSessionManager } from "@/lib/mux-session-manager"
import { processAudioTranslation } from "@/lib/process-audio-translation"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ liveStreamId: string }> }
) {
  const { liveStreamId } = await params
  const ingestToken = request.headers.get("x-salomon-ingest-token")?.trim() || ""

  if (!ingestToken) {
    return NextResponse.json({ error: "Missing ingest token." }, { status: 401 })
  }

  try {
    const session = await muxSessionManager.getIngestSession(liveStreamId, ingestToken)
    if (!session) {
      return NextResponse.json({ error: "Mux session not found." }, { status: 404 })
    }

    if (session.status === "paused") {
      return NextResponse.json({
        paused: true,
        skipped: true,
      })
    }

    const formData = await request.formData()
    const audioFile = formData.get("audio")
    const contextValue = formData.get("context")
    const context = typeof contextValue === "string" ? contextValue.trim() : ""

    if (!(audioFile instanceof File)) {
      return NextResponse.json({ error: "Missing audio file upload." }, { status: 400 })
    }

    await muxSessionManager.updateStatus({
      ingestToken,
      sessionId: liveStreamId,
      status: "transcribing",
    })

    const result = await processAudioTranslation({
      audioFile,
      context,
    })

    if (result.skipped) {
      await muxSessionManager.updateStatus({
        ingestToken,
        sessionId: liveStreamId,
        status: "connected",
      })

      return NextResponse.json({
        metrics: result.metrics,
        paused: false,
        skipped: true,
      })
    }

    const assessment = assessGroqTranslation(result.payload)
    if (assessment.text) {
      await muxSessionManager.appendEntry({
        ingestToken,
        lowConfidence: assessment.lowConfidence,
        sessionId: liveStreamId,
        text: assessment.text,
      })
    } else {
      await muxSessionManager.updateStatus({
        ingestToken,
        sessionId: liveStreamId,
        status: "connected",
      })
    }

    return NextResponse.json({
      lowConfidence: assessment.lowConfidence,
      metrics: result.metrics,
      paused: false,
      skipped: false,
      text: assessment.text,
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to process the Mux audio."

    await muxSessionManager.updateStatus({
      error: message,
      ingestToken,
      sessionId: liveStreamId,
      status: "error",
    })

    console.error("[mux-live-streams] chunk failed", error)
    return NextResponse.json(
      { error: "Unable to process the Mux audio." },
      { status: 500 }
    )
  }
}
