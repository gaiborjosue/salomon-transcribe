import { NextResponse } from "next/server"

import {
  sharedSessionManager,
  type SharedSourceType,
} from "@/lib/shared-session-manager"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      sourceTitle?: string
      sourceType?: SharedSourceType
    }

    const sourceType =
      payload.sourceType === "livestream" ? "livestream" : "microphone"
    const sourceTitle =
      typeof payload.sourceTitle === "string" ? payload.sourceTitle.trim() : undefined

    const session = sharedSessionManager.createSession({
      sourceTitle,
      sourceType,
    })

    return NextResponse.json({
      hostToken: session.hostToken,
      snapshot: session.snapshot,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to create a shared session.",
      },
      { status: 500 }
    )
  }
}
