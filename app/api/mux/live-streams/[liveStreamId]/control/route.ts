import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import { warmServerAudioClassifier } from "@/lib/audio-content-classifier"
import { startMuxIngestSession } from "@/lib/mux-ingest-client"
import { mux } from "@/lib/mux"
import { muxSessionManager } from "@/lib/mux-session-manager"

export const runtime = "nodejs"

function getAppBaseUrl() {
  return process.env.BETTER_AUTH_URL ?? process.env.APP_BASE_URL ?? "http://localhost:3000"
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ liveStreamId: string }> }
) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  const { liveStreamId } = await params

  try {
    const payload = (await request.json().catch(() => null)) as
      | {
          action?: "pause" | "resume"
        }
      | null

    if (!payload?.action || !["pause", "resume"].includes(payload.action)) {
      return NextResponse.json({ error: "Unsupported action." }, { status: 400 })
    }

    const snapshot = await muxSessionManager.getOwnerSession(liveStreamId, session.user.id)
    if (!snapshot) {
      return NextResponse.json({ error: "Mux session not found." }, { status: 404 })
    }

    if (payload.action === "pause") {
      const updated = await muxSessionManager.setHostStatus({
        hostToken: snapshot.hostToken,
        sessionId: liveStreamId,
        status: "paused",
      })

      if (!updated) {
        return NextResponse.json({ error: "Mux session not found." }, { status: 404 })
      }

      return NextResponse.json({ ok: true })
    }

    const updated = await muxSessionManager.setHostStatus({
      hostToken: snapshot.hostToken,
      sessionId: liveStreamId,
      status: "connected",
    })

    if (!updated) {
      return NextResponse.json({ error: "Mux session not found." }, { status: 404 })
    }

    if (snapshot.snapshot.muxStatus === "active") {
      const liveStream = await mux.video.liveStreams.retrieve(liveStreamId)
      await muxSessionManager.syncFromMuxLiveStream(liveStream)
      const workerPayload = await muxSessionManager.prepareWorkerStart(liveStreamId)
      if (workerPayload) {
        try {
          await warmServerAudioClassifier()
          await startMuxIngestSession({
            appBaseUrl: getAppBaseUrl(),
            ingestToken: workerPayload.ingestToken,
            playbackUrl: workerPayload.playbackUrl,
            sessionId: workerPayload.sessionId,
          })
        } catch (error) {
          muxSessionManager.handleWorkerStartFailure(
            liveStreamId,
            error instanceof Error
              ? error.message
              : "Unable to start the Mux ingest worker."
          )
        }
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[mux-live-streams] control failed", error)
    return NextResponse.json(
      { error: "Unable to update the Mux session." },
      { status: 500 }
    )
  }
}
