import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import { updateLivestreamIngestSession } from "@/lib/livestream-ingest-client"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  const { sessionId } = await params

  try {
    const payload = (await request.json()) as {
      action?: "pause" | "resume" | "stop"
    }

    if (
      payload.action === "pause" ||
      payload.action === "resume" ||
      payload.action === "stop"
    ) {
      await updateLivestreamIngestSession(sessionId, payload.action)
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
