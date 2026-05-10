import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import {
  createQwenLiveToken,
  getQwenLiveWorkerWebSocketUrl,
} from "@/lib/qwen-live-token"

export async function POST(request: Request) {
  const authSession = await getApiSession(request)
  if (!authSession) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const payload = (await request.json().catch(() => null)) as
      | { sourceLanguage?: string; targetLanguage?: string }
      | null

    const sourceLanguage =
      typeof payload?.sourceLanguage === "string" && payload.sourceLanguage.trim()
        ? payload.sourceLanguage.trim()
        : "es"
    const targetLanguage =
      typeof payload?.targetLanguage === "string" && payload.targetLanguage.trim()
        ? payload.targetLanguage.trim()
        : "en"

    const token = createQwenLiveToken({
      sourceLanguage,
      targetLanguage,
      userId: authSession.user.id,
    })

    const workerUrl = getQwenLiveWorkerWebSocketUrl()

    return NextResponse.json({
      wsUrl: `${workerUrl}/mic-realtime?token=${encodeURIComponent(token)}`,
    })
  } catch (error) {
    console.error("[qwen-live-token] issue failed", error)
    return NextResponse.json(
      { error: "Unable to start the Qwen realtime session." },
      { status: 500 }
    )
  }
}
