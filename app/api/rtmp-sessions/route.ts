import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import { warmServerAudioClassifier } from "@/lib/audio-content-classifier"
import { rtmpSessionManager } from "@/lib/rtmp-session-manager"
import { startRtmpIngestSession } from "@/lib/rtmp-ingest-client"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const sessions = await rtmpSessionManager.listOwnerSessions(session.user.id)
    return NextResponse.json({
      sessions: sessions.map(({ snapshot }) => ({ snapshot })),
    })
  } catch (error) {
    console.error("[rtmp-sessions] list failed", error)
    return NextResponse.json(
      { error: "Unable to load RTMP sessions." },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  const authSession = await getApiSession(request)
  if (!authSession) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const payload = (await request.json().catch(() => null)) as
      | { sourceTitle?: string }
      | null
    const sourceTitle =
      typeof payload?.sourceTitle === "string" ? payload.sourceTitle.trim() : undefined

    const session = await rtmpSessionManager.createSession({
      ownerUserId: authSession.user.id,
      sourceTitle,
    })

    const appBaseUrl =
      process.env.BETTER_AUTH_URL ??
      process.env.APP_BASE_URL ??
      "http://localhost:3000"

    try {
      await warmServerAudioClassifier()
      await startRtmpIngestSession({
        appBaseUrl,
        ingestToken: session.ingestToken,
        sessionId: session.snapshot.id,
        streamKey: session.snapshot.streamKey,
      })
    } catch (error) {
      await rtmpSessionManager.updateStatus({
        error:
          error instanceof Error
            ? error.message
            : "Unable to reach the RTMP ingest service.",
        ingestToken: session.ingestToken,
        sessionId: session.snapshot.id,
        status: "error",
      })
      throw error
    }

    return NextResponse.json({
      snapshot: session.snapshot,
    })
  } catch (error) {
    console.error("[rtmp-sessions] create failed", error)
    return NextResponse.json(
      { error: "Unable to create an RTMP session." },
      { status: 500 }
    )
  }
}
