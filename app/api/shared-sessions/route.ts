import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import {
  sharedSessionManager,
  type SharedSourceType,
} from "@/lib/shared-session-manager"

export const runtime = "nodejs"

export async function POST(request: Request) {
  const authSession = await getApiSession(request)
  if (!authSession) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const payload = (await request.json()) as {
      sourceTitle?: string
      sourceType?: SharedSourceType
    }

    const sourceType =
      payload.sourceType === "livestream" ? "livestream" : "microphone"
    const sourceTitle =
      typeof payload.sourceTitle === "string" ? payload.sourceTitle.trim() : undefined

    const session = await sharedSessionManager.createSession({
      sourceTitle,
      sourceType,
    })

    return NextResponse.json({
      hostToken: session.hostToken,
      snapshot: session.snapshot,
    })
  } catch (error) {
    console.error("[shared-sessions] create failed", error)
    return NextResponse.json(
      { error: "Unable to create a shared session." },
      { status: 500 }
    )
  }
}
