import { revalidateTag } from "next/cache"
import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import {
  createTranscriptSession,
  getTranscriptSessionDetailTag,
  getTranscriptSessionListTag,
  listTranscriptSessions,
} from "@/lib/transcript-session-store"
import type { TranscriptSessionSource } from "@/lib/transcript-session-types"

function isValidSourceType(value: string | undefined): value is TranscriptSessionSource {
  return value === "microphone" || value === "livestream" || value === "mux" || value === "rtmp"
}

export async function GET(request: Request) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  const sessions = await listTranscriptSessions(session.user.id)
  return NextResponse.json({ sessions })
}

export async function POST(request: Request) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const payload = (await request.json().catch(() => null)) as
      | {
          endedAt?: number
          entries?: Array<{
            id?: string
            lowConfidence?: boolean
            text?: string
            timestampMs?: number
          }>
          sourceTitle?: string
          sourceType?: string
          startedAt?: number
          title?: string
        }
      | null

    if (!isValidSourceType(payload?.sourceType)) {
      return NextResponse.json({ error: "Invalid source type." }, { status: 400 })
    }

    const entries =
      payload?.entries?.map((entry, index) => ({
        id: entry.id || `${Date.now()}-${index}`,
        lowConfidence: Boolean(entry.lowConfidence),
        text: typeof entry.text === "string" ? entry.text : "",
        timestampMs: typeof entry.timestampMs === "number" ? entry.timestampMs : 0,
      })) ?? []

    const created = await createTranscriptSession({
      endedAt: typeof payload?.endedAt === "number" ? payload.endedAt : undefined,
      entries,
      ownerUserId: session.user.id,
      sourceTitle: typeof payload?.sourceTitle === "string" ? payload.sourceTitle : undefined,
      sourceType: payload.sourceType,
      startedAt: typeof payload?.startedAt === "number" ? payload.startedAt : undefined,
      title: typeof payload?.title === "string" ? payload.title : undefined,
    })

    if (!created) {
      return NextResponse.json({ session: null })
    }

    revalidateTag(getTranscriptSessionListTag(session.user.id), "max")
    revalidateTag(
      getTranscriptSessionDetailTag(session.user.id, created.summary.id),
      "max"
    )

    return NextResponse.json({ session: created })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to save the transcript session.",
      },
      { status: 500 }
    )
  }
}
