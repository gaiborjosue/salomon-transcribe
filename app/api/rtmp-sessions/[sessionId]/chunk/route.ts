import { NextResponse } from "next/server"

import { assessGroqTranslation } from "@/lib/groq-translation"
import { processAudioTranslation } from "@/lib/process-audio-translation"
import { rtmpSessionManager } from "@/lib/rtmp-session-manager"

export const runtime = "nodejs"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params
  const ingestToken = request.headers.get("x-salomon-ingest-token")?.trim() || ""

  if (!ingestToken) {
    return NextResponse.json({ error: "Missing ingest token." }, { status: 401 })
  }

  try {
    const session = rtmpSessionManager.getIngestSession(sessionId, ingestToken)
    if (!session) {
      return NextResponse.json({ error: "RTMP session not found." }, { status: 404 })
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
    const context =
      typeof contextValue === "string" ? contextValue.trim() : ""

    if (!(audioFile instanceof File)) {
      return NextResponse.json({ error: "Missing audio file upload." }, { status: 400 })
    }

    rtmpSessionManager.updateStatus({
      ingestToken,
      sessionId,
      status: "transcribing",
    })

    const result = await processAudioTranslation({
      audioFile,
      context,
    })

    if (result.skipped) {
      rtmpSessionManager.updateStatus({
        ingestToken,
        sessionId,
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
      rtmpSessionManager.appendEntry({
        ingestToken,
        lowConfidence: assessment.lowConfidence,
        sessionId,
        text: assessment.text,
      })
    } else {
      rtmpSessionManager.updateStatus({
        ingestToken,
        sessionId,
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
      error instanceof Error ? error.message : "Unable to process the RTMP audio."

    rtmpSessionManager.updateStatus({
      error: message,
      ingestToken,
      sessionId,
      status: "error",
    })

    return NextResponse.json({ error: message }, { status: 500 })
  }
}
