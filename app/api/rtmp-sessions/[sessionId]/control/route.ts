import { NextResponse } from "next/server"

import { stopRtmpIngestSession } from "@/lib/rtmp-ingest-client"
import { rtmpSessionManager } from "@/lib/rtmp-session-manager"

export const runtime = "nodejs"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params

  try {
    const payload = (await request.json().catch(() => null)) as
      | {
          action?: "pause" | "resume" | "stop"
          hostToken?: string
        }
      | null

    if (
      !payload?.action ||
      typeof payload.hostToken !== "string" ||
      !["pause", "resume", "stop"].includes(payload.action)
    ) {
      return NextResponse.json({ error: "Unsupported action." }, { status: 400 })
    }

    const snapshot = rtmpSessionManager.getHostSession(sessionId, payload.hostToken)
    if (!snapshot) {
      return NextResponse.json({ error: "RTMP session not found." }, { status: 404 })
    }

    if (payload.action === "pause") {
      const updated = rtmpSessionManager.setHostStatus({
        hostToken: payload.hostToken,
        sessionId,
        status: "paused",
      })

      if (!updated) {
        return NextResponse.json({ error: "RTMP session not found." }, { status: 404 })
      }

      return NextResponse.json({ ok: true })
    }

    if (payload.action === "resume") {
      const updated = rtmpSessionManager.setHostStatus({
        hostToken: payload.hostToken,
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

    rtmpSessionManager.endByHost({
      hostToken: payload.hostToken,
      sessionId,
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to update the RTMP session.",
      },
      { status: 500 }
    )
  }
}
