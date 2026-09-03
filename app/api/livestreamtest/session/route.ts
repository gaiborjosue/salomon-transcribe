import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import { startLivestreamIngestSession } from "@/lib/livestream-ingest-client"
import type { LivestreamMode } from "@/lib/livestream-types"

export async function POST(request: Request) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const payload = (await request.json()) as {
      mode?: LivestreamMode
      streamUrl?: string
      transcriptionMode?: LivestreamMode
    }

    const streamUrl = typeof payload.streamUrl === "string" ? payload.streamUrl.trim() : ""
    const mode =
      payload.transcriptionMode === "sermon" || payload.mode === "sermon"
        ? "sermon"
        : "conversation"

    if (!streamUrl) {
      return NextResponse.json(
        { error: "A YouTube livestream URL is required." },
        { status: 400 }
      )
    }

    const sessionId = await startLivestreamIngestSession({
      mode,
      streamUrl,
    })

    return NextResponse.json({
      sessionId,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to start the livestream session.",
      },
      { status: 500 }
    )
  }
}
