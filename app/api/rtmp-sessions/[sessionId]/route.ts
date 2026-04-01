import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import { rtmpSessionManager } from "@/lib/rtmp-session-manager"

export const runtime = "nodejs"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  const { sessionId } = await params
  try {
    const ownerSession = await rtmpSessionManager.getOwnerSession(
      sessionId,
      session.user.id
    )

    if (!ownerSession) {
      return NextResponse.json({ error: "RTMP session not found." }, { status: 404 })
    }

    return NextResponse.json({
      snapshot: ownerSession.snapshot,
    })
  } catch (error) {
    console.error("[rtmp-sessions] get failed", error)
    return NextResponse.json(
      { error: "Unable to load the RTMP session." },
      { status: 500 }
    )
  }
}
