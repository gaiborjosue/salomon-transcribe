import { getIngestControlHeaders } from "@/lib/ingest-control"
import type { LivestreamSessionSnapshot } from "@/lib/livestream-types"

const DEFAULT_INGEST_BASE_URL = "http://127.0.0.1:4100"

export class LivestreamIngestUnavailableError extends Error {
  constructor(cause: unknown) {
    const message = "Unable to reach the livestream ingest service."
    super(
      process.env.NODE_ENV === "development"
        ? `${message} Start it with pnpm ingest:dev.`
        : message,
      { cause }
    )
    this.name = "LivestreamIngestUnavailableError"
  }
}

function getConfiguredBaseUrl() {
  return (
    process.env.LIVESTREAM_INGEST_BASE_URL?.trim() ||
    process.env.RTMP_INGEST_BASE_URL?.trim() ||
    (process.env.NODE_ENV === "production" ? "" : DEFAULT_INGEST_BASE_URL)
  )
}

function getIngestUrl(pathname: string, { publicUrl = false } = {}) {
  const baseUrl =
    (publicUrl
      ? process.env.LIVESTREAM_INGEST_PUBLIC_BASE_URL?.trim()
      : "") || getConfiguredBaseUrl()

  if (!baseUrl) {
    throw new Error(
      "LIVESTREAM_INGEST_BASE_URL is not configured for the production ingest service."
    )
  }

  return new URL(pathname, baseUrl).toString()
}

async function getErrorMessage(response: Response, fallback: string) {
  const body = await response.text()
  if (!body) return fallback

  try {
    const payload = JSON.parse(body) as { error?: unknown }
    return typeof payload.error === "string" && payload.error.trim()
      ? payload.error
      : fallback
  } catch {
    return body
  }
}

export async function startLivestreamIngestSession(streamUrl: string) {
  const response = await fetch(getIngestUrl("/youtube-sessions"), {
    method: "POST",
    headers: getIngestControlHeaders(),
    body: JSON.stringify({ streamUrl }),
  }).catch((cause: unknown) => {
    throw new LivestreamIngestUnavailableError(cause)
  })

  if (!response.ok) {
    throw new Error(
      await getErrorMessage(
        response,
        `Livestream ingest service failed to start (${response.status}).`
      )
    )
  }

  const result = (await response.json()) as { sessionId?: unknown }
  if (typeof result.sessionId !== "string" || !result.sessionId.trim()) {
    throw new Error("Livestream ingest service returned an invalid session.")
  }

  return result.sessionId
}

export async function updateLivestreamIngestSession(
  sessionId: string,
  action: "pause" | "resume" | "stop"
) {
  const response = await fetch(
    getIngestUrl(`/youtube-sessions/${encodeURIComponent(sessionId)}/control`),
    {
      method: "POST",
      headers: getIngestControlHeaders(),
      body: JSON.stringify({ action }),
    }
  )

  if (!response.ok) {
    throw new Error(
      await getErrorMessage(
        response,
        `Livestream ${action} failed with status ${response.status}.`
      )
    )
  }

  const result = (await response.json()) as { snapshot?: LivestreamSessionSnapshot }
  return result.snapshot
}

export function getLivestreamIngestEventsUrl(sessionId: string) {
  return getIngestUrl(
    `/youtube-sessions/${encodeURIComponent(sessionId)}/events`,
    { publicUrl: true }
  )
}
