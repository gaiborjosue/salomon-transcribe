import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import { stopRtmpIngestSession } from "@/lib/rtmp-ingest-client"
import { rtmpSessionManager } from "@/lib/rtmp-session-manager"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const payload = (await request.json().catch(() => null)) as
      | {
          action?: "pause" | "resume" | "stop"
        }
      | null

    if (!payload?.action || !["pause", "resume", "stop"].includes(payload.action)) {
      return NextResponse.json({ error: "Unsupported action." }, { status: 400 })
    }

    const ownerSession = await rtmpSessionManager.getOwnerSession(
      sessionId,
      session.user.id
    )
    if (!ownerSession) {
      return NextResponse.json({ error: "RTMP session not found." }, { status: 404 })
    }

    if (payload.action === "pause") {
      const updated = await rtmpSessionManager.setHostStatus({
        hostToken: ownerSession.hostToken,
        sessionId,
        status: "paused",
      })

      if (!updated) {
        return NextResponse.json({ error: "RTMP session not found." }, { status: 404 })
      }

      return NextResponse.json({ ok: true })
    }

    if (payload.action === "resume") {
      const updated = await rtmpSessionManager.setHostStatus({
        hostToken: ownerSession.hostToken,
        sessionId,
        status: "connected",
      })

      if (!updated) {
        return NextResponse.json({ error: "RTMP session not found." }, { status: 404 })
      }

      return NextResponse.json({ ok: true })
    }

    try {
      await stopRtmpIngestSession(sessionId)
    } catch {
      // If the ingest service is already down, still end the local session state.
    }

    await rtmpSessionManager.endByHost({
      hostToken: ownerSession.hostToken,
      sessionId,
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[rtmp-sessions] control failed", error)
    return NextResponse.json(
      { error: "Unable to update the RTMP session." },
      { status: 500 }
    )
  }
}
