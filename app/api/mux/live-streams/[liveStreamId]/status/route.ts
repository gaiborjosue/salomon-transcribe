import { NextResponse } from "next/server"

import { muxSessionManager } from "@/lib/mux-session-manager"
import type { MuxProcessingStatus } from "@/lib/mux-session-types"

export const runtime = "nodejs"

function normalizeStatus(input: string | undefined): MuxProcessingStatus | null {
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
  { params }: { params: Promise<{ liveStreamId: string }> }
) {
  const { liveStreamId } = await params
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

    const updated = await muxSessionManager.updateStatus({
      error: typeof payload?.error === "string" ? payload.error : undefined,
      ingestToken,
      sessionId: liveStreamId,
      status,
    })

    if (!updated) {
      return NextResponse.json({ error: "Mux session not found." }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to update the Mux session status.",
      },
      { status: 500 }
    )
  }
}
