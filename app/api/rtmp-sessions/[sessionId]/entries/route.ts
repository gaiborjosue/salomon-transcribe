import { NextResponse } from "next/server"

import { parseTranscriptSpeakerId } from "@/lib/transcript-types"

import { rtmpSessionManager } from "@/lib/rtmp-session-manager"

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
    const payload = (await request.json().catch(() => null)) as
      | { lowConfidence?: boolean; speakerId?: unknown; text?: string }
      | null

    if (typeof payload?.text !== "string" || !payload.text.trim()) {
      return NextResponse.json({ error: "Missing transcript text." }, { status: 400 })
    }

    const appended = await rtmpSessionManager.appendEntry({
      ingestToken,
      lowConfidence: payload.lowConfidence === true,
      speakerId: parseTranscriptSpeakerId(payload.speakerId),
      sessionId,
      text: payload.text,
    })

    if (!appended) {
      return NextResponse.json({ error: "RTMP session not found." }, { status: 404 })
    }

    const session = await rtmpSessionManager.getIngestSession(sessionId, ingestToken)

    return NextResponse.json({
      currentStatus: session?.status,
      ok: true,
    })
  } catch (error) {
    console.error("[rtmp-sessions] entry append failed", error)
    return NextResponse.json(
      { error: "Unable to append the RTMP transcript entry." },
      { status: 500 }
    )
  }
}
