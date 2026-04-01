import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import { MUX_RTMP_PUBLISH_URL, getMuxPlaybackUrl, getPublicMuxPlaybackId } from "@/lib/mux-live-utils"
import { mux } from "@/lib/mux"
import { muxSessionManager } from "@/lib/mux-session-manager"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const sessions = await muxSessionManager.listOwnerSessions(session.user.id)
    return NextResponse.json({
      sessions: sessions.map(({ snapshot }) => ({ snapshot })),
    })
  } catch (error) {
    console.error("[mux-live-streams] list failed", error)
    return NextResponse.json(
      { error: "Unable to load Mux sessions." },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  try {
    const liveStream = await mux.video.liveStreams.create({
      audio_only: true,
      latency_mode: "standard",
      playback_policies: ["public"],
      passthrough: "salomon-audio-only",
      new_asset_settings: {
        playback_policies: ["public"],
      },
      reconnect_window: 60,
    })

    const persistedSession = await muxSessionManager.createSession({
      liveStream,
      ownerUserId: session.user.id,
    })
    const playbackId = getPublicMuxPlaybackId(liveStream)

    return NextResponse.json({
      snapshot: {
        ...persistedSession.snapshot,
        audioOnly: Boolean(liveStream.audio_only),
        playbackId,
        playbackUrl: getMuxPlaybackUrl(playbackId),
        publishUrl: MUX_RTMP_PUBLISH_URL,
      },
    })
  } catch (error) {
    console.error("[mux-live-streams] create failed", error)
    return NextResponse.json(
      { error: "Unable to create the Mux live stream." },
      { status: 500 }
    )
  }
}
