import { NextResponse } from "next/server"

import type { MuxPerfTrace } from "@/lib/mux-session-types"
import { muxSessionManager } from "@/lib/mux-session-manager"

function isMuxPerfTrace(value: unknown): value is MuxPerfTrace {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as Partial<MuxPerfTrace>
  return (
    typeof candidate.id === "string" &&
    typeof candidate.segmentDurationMs === "number" &&
    typeof candidate.source === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.responseSkipped === "boolean" &&
    typeof candidate.workerTotalMs === "number"
  )
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

  const payload = (await request.json().catch(() => null)) as { perf?: unknown } | null
  if (!isMuxPerfTrace(payload?.perf)) {
    return NextResponse.json({ error: "Invalid perf payload." }, { status: 400 })
  }

  const emitted = await muxSessionManager.emitPerf({
    ingestToken,
    perf: payload.perf,
    sessionId: liveStreamId,
  })

  if (!emitted) {
    return NextResponse.json({ error: "Mux session not found." }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
