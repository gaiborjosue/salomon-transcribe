import { NextResponse } from "next/server"

import { livestreamSessionManager } from "@/lib/livestream-session-manager"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params
  const session = livestreamSessionManager.getSession(sessionId)

  if (!session) {
    return NextResponse.json({ error: "Livestream session not found." }, { status: 404 })
  }

  try {
    const payload = (await request.json()) as {
      action?: "pause" | "resume" | "stop"
    }

    if (payload.action === "pause") {
      await session.pause()
      return NextResponse.json({ ok: true })
    }

    if (payload.action === "resume") {
      await session.resume()
      return NextResponse.json({ ok: true })
    }

    if (payload.action === "stop") {
      await livestreamSessionManager.stopSession(sessionId)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: "Unsupported action." }, { status: 400 })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to update the livestream session.",
      },
      { status: 500 }
    )
  }
}
