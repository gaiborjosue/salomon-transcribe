import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import { createSonioxClient } from "@/lib/soniox-server"

export async function POST(request: Request) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const { api_key, expires_at } = await createSonioxClient().auth.createTemporaryKey(
      {
        usage_type: "transcribe_websocket",
        expires_in_seconds: 60,
        single_use: true,
        client_reference_id: session.user.id,
      },
      AbortSignal.timeout(10_000)
    )
    return NextResponse.json(
      { api_key, expires_at },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    console.error("[soniox-token] Temporary key request failed:", error instanceof Error && error.message)
    return NextResponse.json(
      { error: "Unable to start Soniox microphone translation." },
      { status: 502 }
    )
  }
}
