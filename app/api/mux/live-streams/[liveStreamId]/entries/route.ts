import { NextResponse } from "next/server"

import { muxSessionManager } from "@/lib/mux-session-manager"

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
      | { lowConfidence?: boolean; text?: string }
      | null

    if (typeof payload?.text !== "string" || !payload.text.trim()) {
      return NextResponse.json({ error: "Missing transcript text." }, { status: 400 })
    }

    const appended = await muxSessionManager.appendEntry({
      ingestToken,
      lowConfidence: payload.lowConfidence === true,
      sessionId: liveStreamId,
      text: payload.text,
    })

    if (!appended) {
      return NextResponse.json({ error: "Mux session not found." }, { status: 404 })
    }

    const session = await muxSessionManager.getIngestSession(liveStreamId, ingestToken)

    return NextResponse.json({
      currentMuxStatus: session?.muxStatus,
      currentStatus: session?.status,
      ok: true,
    })
  } catch (error) {
    console.error("[mux-live-streams] entry append failed", error)
    return NextResponse.json(
      { error: "Unable to append the Mux transcript entry." },
      { status: 500 }
    )
  }
}
