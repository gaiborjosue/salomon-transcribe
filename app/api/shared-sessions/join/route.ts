import { NextResponse } from "next/server"

import { sharedSessionManager } from "@/lib/shared-session-manager"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { code?: string }
    const code = typeof payload.code === "string" ? payload.code.trim().toUpperCase() : ""

    if (!code) {
      return NextResponse.json(
        { error: "Enter a share code." },
        { status: 400 }
      )
    }

    const snapshot = sharedSessionManager.getSnapshotByCode(code)

    if (!snapshot) {
      return NextResponse.json(
        { error: "Share code not found." },
        { status: 404 }
      )
    }

    return NextResponse.json({ snapshot })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to join this shared session.",
      },
      { status: 500 }
    )
  }
}
