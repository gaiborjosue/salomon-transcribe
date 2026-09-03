import { NextResponse } from "next/server"

import { warmServerAudioClassifier } from "@/lib/audio-content-classifier"
import { bestEffortDeleteMuxAssetsForLiveStream } from "@/lib/mux-live-assets"
import { mux } from "@/lib/mux"
import { startMuxIngestSession, stopMuxIngestSession } from "@/lib/mux-ingest-client"
import { muxSessionManager } from "@/lib/mux-session-manager"

function getAppBaseUrl() {
  return process.env.BETTER_AUTH_URL ?? process.env.APP_BASE_URL ?? "http://localhost:3000"
}

export async function POST(request: Request) {
  try {
    const body = await request.text()
    const event = mux.webhooks.unwrap(body, request.headers)

    const liveStreamId =
      typeof event.data === "object" &&
      event.data !== null &&
      "id" in event.data &&
      typeof event.data.id === "string"
        ? event.data.id
        : null

    if (!liveStreamId) {
      return NextResponse.json({ ok: true })
    }

    if (event.type === "video.live_stream.active") {
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
          await muxSessionManager.handleWorkerStartFailure(
            liveStreamId,
            error instanceof Error
              ? error.message
              : "Unable to start the Mux ingest worker."
          )
        }
      }

      return NextResponse.json({ ok: true })
    }

    if (
      event.type === "video.live_stream.idle" ||
      event.type === "video.live_stream.disconnected"
    ) {
      const liveStream = await mux.video.liveStreams.retrieve(liveStreamId)
      await bestEffortDeleteMuxAssetsForLiveStream(liveStream)
      await muxSessionManager.syncFromMuxLiveStream(liveStream)
      const stopPayload = await muxSessionManager.prepareWorkerStop(liveStreamId)

      if (stopPayload) {
        try {
          await stopMuxIngestSession(stopPayload.sessionId)
        } catch {
          // The worker may already be down locally.
        }
      }

      return NextResponse.json({ ok: true })
    }

    if (
      event.type === "video.live_stream.disabled" ||
      event.type === "video.live_stream.deleted"
    ) {
      if (event.type === "video.live_stream.disabled") {
        const liveStream = await mux.video.liveStreams.retrieve(liveStreamId)
        await bestEffortDeleteMuxAssetsForLiveStream(liveStream)
        await muxSessionManager.syncFromMuxLiveStream(liveStream)
      } else {
        await muxSessionManager.syncFromMuxLiveStream({
          id: liveStreamId,
          status: "deleted",
        })
      }
      const stopPayload = await muxSessionManager.prepareWorkerStop(liveStreamId)

      if (stopPayload) {
        try {
          await stopMuxIngestSession(stopPayload.sessionId)
        } catch {
          // The worker may already be down locally.
        }
      }

      return NextResponse.json({ ok: true })
    }

    if (event.type === "video.live_stream.connected") {
      const liveStream = await mux.video.liveStreams.retrieve(liveStreamId)
      await muxSessionManager.syncFromMuxLiveStream(liveStream)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to process the Mux webhook.",
      },
      { status: 400 }
    )
  }
}
