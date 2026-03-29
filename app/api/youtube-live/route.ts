import { NextResponse } from "next/server"

export const runtime = "nodejs"

const CHANNEL_ID = "UC9KL3tLQfmky4fxbFlQGt5A"
const SEARCH_ENDPOINT = "https://www.googleapis.com/youtube/v3/search"

export async function GET() {
  const apiKey = process.env.GOOGLE_API_KEY

  if (!apiKey) {
    return NextResponse.json(
      { error: "GOOGLE_API_KEY is not configured." },
      { status: 500 }
    )
  }

  const params = new URLSearchParams({
    part: "snippet",
    channelId: CHANNEL_ID,
    eventType: "live",
    type: "video",
    key: apiKey,
  })

  try {
    const response = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
    })

    const payload = await response.json().catch(() => null)

    if (!response.ok) {
      const message =
        typeof payload?.error?.message === "string"
          ? payload.error.message
          : "Unable to check the channel right now."

      return NextResponse.json({ error: message }, { status: response.status })
    }

    const items = Array.isArray(payload?.items) ? payload.items : []
    const liveItem = items[0]

    if (!liveItem?.id?.videoId) {
      return NextResponse.json({ live: false })
    }

    const videoId = String(liveItem.id.videoId)
    const title =
      typeof liveItem?.snippet?.title === "string" ? liveItem.snippet.title : ""
    const thumbnail =
      typeof liveItem?.snippet?.thumbnails?.high?.url === "string"
        ? liveItem.snippet.thumbnails.high.url
        : typeof liveItem?.snippet?.thumbnails?.medium?.url === "string"
          ? liveItem.snippet.thumbnails.medium.url
          : undefined

    return NextResponse.json({
      live: true,
      title,
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to check the channel right now.",
      },
      { status: 500 }
    )
  }
}
