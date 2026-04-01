import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import { warmServerAudioClassifier } from "@/lib/audio-content-classifier"
import { getMuxPlaybackUrl, getPublicMuxPlaybackId } from "@/lib/mux-live-utils"
import { startMuxIngestSession, stopMuxIngestSession } from "@/lib/mux-ingest-client"
import { mux } from "@/lib/mux"
import { muxSessionManager } from "@/lib/mux-session-manager"

export const runtime = "nodejs"

function getAppBaseUrl() {
  return process.env.BETTER_AUTH_URL ?? process.env.APP_BASE_URL ?? "http://localhost:3000"
}

function isMuxNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false
  }

  const status =
    "status" in error && typeof error.status === "number"
      ? error.status
      : "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : null

  if (status === 404) {
    return true
  }

  const message =
    "message" in error && typeof error.message === "string"
      ? error.message.toLowerCase()
      : ""

  return message.includes("not found") || message.includes("404")
}

function isMuxAlreadyDisabledError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false
  }

  const message =
    "message" in error && typeof error.message === "string"
      ? error.message.toLowerCase()
      : ""

  return message.includes("already disabled") || message.includes("is disabled")
}

function isMuxActiveDeleteError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false
  }

  const message =
    "message" in error && typeof error.message === "string"
      ? error.message.toLowerCase()
      : ""

  return (
    message.includes("cannot be deleted while 'active'") ||
    message.includes("cannot be deleted while active") ||
    message.includes("call 'complete' on the live stream before deleting it")
  )
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function bestEffortDisableLiveStream(liveStreamId: string) {
  try {
    await mux.video.liveStreams.disable(liveStreamId)
  } catch (error) {
    if (isMuxNotFoundError(error) || isMuxAlreadyDisabledError(error)) {
      return
    }

    throw error
  }
}

async function bestEffortDeleteLiveStream(liveStreamId: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mux.video.liveStreams.delete(liveStreamId)
      return
    } catch (error) {
      if (isMuxNotFoundError(error)) {
        return
      }

      if (isMuxActiveDeleteError(error) && attempt < 2) {
        await delay(250)
        continue
      }

      throw error
    }
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ liveStreamId: string }> }
) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const { liveStreamId } = await params
    const snapshot = await muxSessionManager.getOwnerSession(liveStreamId, session.user.id)
    if (!snapshot) {
      return NextResponse.json({ error: "Mux live stream not found." }, { status: 404 })
    }

    let liveStream
    try {
      liveStream = await mux.video.liveStreams.retrieve(liveStreamId)
    } catch (error) {
      if (!isMuxNotFoundError(error)) {
        throw error
      }

      await muxSessionManager.syncFromMuxLiveStream({
        id: liveStreamId,
        status: "deleted",
      })
      const stopPayload = await muxSessionManager.prepareWorkerStop(liveStreamId)
      if (stopPayload) {
        try {
          await stopMuxIngestSession(stopPayload.sessionId)
        } catch {
          // The worker may already be down locally.
        }
      }

      const endedSnapshot = await muxSessionManager.getHostSession(
        liveStreamId,
        snapshot.hostToken
      )
      if (!endedSnapshot) {
        return NextResponse.json({ error: "Mux live stream not found." }, { status: 404 })
      }

      return NextResponse.json({ snapshot: endedSnapshot })
    }

    await muxSessionManager.syncFromMuxLiveStream(liveStream)
    if (liveStream.status === "active") {
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
          await muxSessionManager.handleWorkerStartFailure(
            liveStreamId,
            error instanceof Error
              ? error.message
              : "Unable to start the Mux ingest worker."
          )
        }
      }
    }
    if (liveStream.status === "idle" || liveStream.status === "disabled") {
      const stopPayload = await muxSessionManager.prepareWorkerStop(liveStreamId)
      if (stopPayload) {
        try {
          await stopMuxIngestSession(stopPayload.sessionId)
        } catch {
          // The worker may already be down locally.
        }
      }
    }
    const refreshed = await muxSessionManager.getHostSession(
      liveStreamId,
      snapshot.hostToken
    )
    const playbackId = getPublicMuxPlaybackId(liveStream)

    return NextResponse.json({
      snapshot: refreshed ?? {
        ...snapshot.snapshot,
        audioOnly: Boolean(liveStream.audio_only),
        muxStatus: liveStream.status ?? snapshot.snapshot.muxStatus,
        playbackId,
        playbackUrl: getMuxPlaybackUrl(playbackId),
        streamKey: liveStream.stream_key ?? snapshot.snapshot.streamKey,
      },
    })
  } catch (error) {
    console.error("[mux-live-streams] get failed", error)
    return NextResponse.json(
      { error: "Unable to load the Mux live stream." },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ liveStreamId: string }> }
) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const { liveStreamId } = await params
    const existingSession = await muxSessionManager.getOwnerSession(liveStreamId, session.user.id)
    if (!existingSession) {
      return NextResponse.json({ error: "Mux session not found." }, { status: 404 })
    }

    await bestEffortDisableLiveStream(liveStreamId)
    await bestEffortDeleteLiveStream(liveStreamId)
    const stopPayload = await muxSessionManager.prepareWorkerStop(liveStreamId)
    if (stopPayload) {
      try {
        await stopMuxIngestSession(stopPayload.sessionId)
      } catch {
        // The worker may already be down locally.
      }
    }
    await muxSessionManager.endByHost({
      hostToken: existingSession.hostToken,
      sessionId: liveStreamId,
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[mux-live-streams] delete failed", error)
    return NextResponse.json(
      { error: "Unable to delete the Mux live stream." },
      { status: 500 }
    )
  }
}
