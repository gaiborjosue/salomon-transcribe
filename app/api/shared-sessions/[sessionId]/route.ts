import { NextResponse } from "next/server"

import { sharedSessionManager } from "@/lib/shared-session-manager"
import type { TranscriptEntry } from "@/components/transcriber-ui"
import { getApiSession } from "@/lib/api-auth"
import { muxSessionManager } from "@/lib/mux-session-manager"

export const runtime = "nodejs"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params
  const snapshot =
    (await sharedSessionManager.ensureSnapshotById(sessionId)) ??
    (await muxSessionManager.ensureSharedSessionById(sessionId))

  if (!snapshot) {
    return NextResponse.json(
      { error: "Shared session not found." },
      { status: 404 }
    )
  }

  return NextResponse.json({ snapshot })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const authSession = await getApiSession(request)
  if (!authSession) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  const { sessionId } = await params

  try {
    const payload = (await request.json()) as {
      entry?: TranscriptEntry
      entries?: TranscriptEntry[]
      hostToken?: string
      sourceTitle?: string
      type?: "append" | "end" | "meta" | "sync"
    }

    const hostToken =
      typeof payload.hostToken === "string" ? payload.hostToken.trim() : ""

    if (!hostToken) {
      return NextResponse.json(
        { error: "Missing host token." },
        { status: 400 }
      )
    }

    if (payload.type === "append") {
      if (!payload.entry) {
        return NextResponse.json(
          { error: "Missing transcript entry." },
          { status: 400 }
        )
      }

      const ok = await sharedSessionManager.appendEntry({
        entry: payload.entry,
        hostToken,
        sessionId,
      })

      if (!ok) {
        return NextResponse.json(
          { error: "Shared session not found." },
          { status: 404 }
        )
      }

      return NextResponse.json({ ok: true })
    }

    if (payload.type === "meta") {
      const ok = await sharedSessionManager.updateMetadata({
        hostToken,
        sessionId,
        sourceTitle:
          typeof payload.sourceTitle === "string"
            ? payload.sourceTitle.trim()
            : undefined,
      })

      if (!ok) {
        return NextResponse.json(
          { error: "Shared session not found." },
          { status: 404 }
        )
      }

      return NextResponse.json({ ok: true })
    }

    if (payload.type === "sync") {
      if (!Array.isArray(payload.entries)) {
        return NextResponse.json(
          { error: "Missing transcript entries." },
          { status: 400 }
        )
      }

      const ok = await sharedSessionManager.syncSession({
        entries: payload.entries,
        hostToken,
        sessionId,
        sourceTitle:
          typeof payload.sourceTitle === "string"
            ? payload.sourceTitle.trim()
            : undefined,
      })

      if (!ok) {
        return NextResponse.json(
          { error: "Shared session not found." },
          { status: 404 }
        )
      }

      return NextResponse.json({ ok: true })
    }

    if (payload.type === "end") {
      const ok = await sharedSessionManager.endSession({
        hostToken,
        sessionId,
      })

      if (!ok) {
        return NextResponse.json(
          { error: "Shared session not found." },
          { status: 404 }
        )
      }

      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: "Unsupported action." }, { status: 400 })
  } catch (error) {
    console.error("[shared-sessions] update failed", error)
    return NextResponse.json(
      { error: "Unable to update the shared session." },
      { status: 500 }
    )
  }
}
