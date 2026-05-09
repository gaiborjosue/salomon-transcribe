import { NextResponse } from "next/server"

import { rtmpSessionManager } from "@/lib/rtmp-session-manager"
import type { RtmpSessionStatus } from "@/lib/rtmp-types"

function normalizeStatus(input: string | undefined): RtmpSessionStatus | null {
  switch (input) {
    case "connecting":
    case "connected":
    case "paused":
    case "transcribing":
    case "disconnected":
    case "error":
      return input
    default:
      return null
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params
  const ingestToken = request.headers.get("x-salomon-ingest-token")?.trim() || ""

  if (!ingestToken) {
    return NextResponse.json({ error: "Missing ingest token." }, { status: 401 })
  }

  try {
    const payload = (await request.json().catch(() => null)) as
      | { error?: string; status?: string }
      | null
    const status = normalizeStatus(payload?.status)

    if (!status) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 })
    }

    const updated = await rtmpSessionManager.updateStatus({
      error: typeof payload?.error === "string" ? payload.error : undefined,
      ingestToken,
      sessionId,
      status,
    })

    if (!updated) {
      return NextResponse.json({ error: "RTMP session not found." }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to update the RTMP session status.",
      },
      { status: 500 }
    )
  }
}
