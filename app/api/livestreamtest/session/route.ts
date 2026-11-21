import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import { startLivestreamIngestSession } from "@/lib/livestream-ingest-client"

export async function POST(request: Request) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const payload = (await request.json().catch(() => null)) as { streamUrl?: unknown } | null
    const streamUrl = typeof payload?.streamUrl === "string" ? payload.streamUrl.trim() : ""

    if (!streamUrl) {
      return NextResponse.json(
        { error: "A YouTube livestream URL is required." },
        { status: 400 }
      )
    }

    const sessionId = await startLivestreamIngestSession(streamUrl)

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
