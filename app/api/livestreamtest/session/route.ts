import { NextResponse } from "next/server"

import { livestreamSessionManager } from "@/lib/livestream-session-manager"
import type { LivestreamMode } from "@/lib/livestream-types"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      mode?: LivestreamMode
      streamUrl?: string
    }

    const streamUrl = typeof payload.streamUrl === "string" ? payload.streamUrl.trim() : ""
    const mode = payload.mode === "sermon" ? "sermon" : "conversation"

    if (!streamUrl) {
      return NextResponse.json(
        { error: "A YouTube livestream URL is required." },
        { status: 400 }
      )
    }

    const session = await livestreamSessionManager.createSession({
      mode,
      streamUrl,
    })

    return NextResponse.json({
      sessionId: session.getSnapshot().id,
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
