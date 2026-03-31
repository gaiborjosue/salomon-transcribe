import { NextResponse } from "next/server"

import { rtmpSessionManager } from "@/lib/rtmp-session-manager"
import { startRtmpIngestSession } from "@/lib/rtmp-ingest-client"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => null)) as
      | { sourceTitle?: string }
      | null
    const sourceTitle =
      typeof payload?.sourceTitle === "string" ? payload.sourceTitle.trim() : undefined

    const session = rtmpSessionManager.createSession({
      sourceTitle,
    })

    const appBaseUrl =
      process.env.BETTER_AUTH_URL ??
      process.env.APP_BASE_URL ??
      "http://localhost:3000"

    try {
      await startRtmpIngestSession({
        appBaseUrl,
        ingestToken: session.ingestToken,
        sessionId: session.snapshot.id,
        streamKey: session.snapshot.streamKey,
      })
    } catch (error) {
      rtmpSessionManager.updateStatus({
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
      hostToken: session.hostToken,
      snapshot: session.snapshot,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to create an RTMP session.",
      },
      { status: 500 }
    )
  }
}
