import { NextResponse } from "next/server"

import { sharedSessionManager } from "@/lib/shared-session-manager"
import type { TranscriptEntry } from "@/components/transcriber-ui"

export const runtime = "nodejs"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
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

      const ok = sharedSessionManager.appendEntry({
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
      const ok = sharedSessionManager.updateMetadata({
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

      const ok = sharedSessionManager.syncSession({
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
      const ok = sharedSessionManager.endSession({
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
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to update the shared session.",
      },
      { status: 500 }
    )
  }
}
