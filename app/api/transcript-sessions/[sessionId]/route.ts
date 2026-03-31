import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import {
  deleteTranscriptSession,
  getTranscriptSessionDetail,
  updateTranscriptSession,
} from "@/lib/transcript-session-store"

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
  const transcriptSession = await getTranscriptSessionDetail({
    ownerUserId: session.user.id,
    sessionId,
  })

  if (!transcriptSession) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 })
  }

  return NextResponse.json({ session: transcriptSession })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const { sessionId } = await params
    const payload = (await request.json().catch(() => null)) as
      | { archived?: boolean; title?: string }
      | null

    const updated = await updateTranscriptSession({
      archived: typeof payload?.archived === "boolean" ? payload.archived : undefined,
      ownerUserId: session.user.id,
      sessionId,
      title: typeof payload?.title === "string" ? payload.title : undefined,
    })

    if (!updated) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 })
    }

    return NextResponse.json({ session: updated })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to update the transcript session.",
      },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  const { sessionId } = await params
  const deleted = await deleteTranscriptSession({
    ownerUserId: session.user.id,
    sessionId,
  })

  if (!deleted) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
