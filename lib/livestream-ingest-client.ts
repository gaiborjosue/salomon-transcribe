const DEFAULT_INGEST_BASE_URL = "http://127.0.0.1:4100"

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

function getControlHeaders() {
  const controlSecret = process.env.INGEST_CONTROL_SECRET?.trim()
  if (!controlSecret && process.env.NODE_ENV === "production") {
    throw new Error(
      "INGEST_CONTROL_SECRET is not configured for the production ingest service."
    )
  }

  return {
    "Content-Type": "application/json",
    ...(controlSecret
      ? { "x-salomon-ingest-secret": controlSecret }
      : {}),
  }
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

export async function startLivestreamIngestSession(payload: {
  mode: "conversation" | "sermon"
  streamUrl: string
}) {
  const response = await fetch(getIngestUrl("/youtube-sessions"), {
    method: "POST",
    headers: getControlHeaders(),
    body: JSON.stringify(payload),
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
      headers: getControlHeaders(),
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
}

export function getLivestreamIngestEventsUrl(sessionId: string) {
  return getIngestUrl(
    `/youtube-sessions/${encodeURIComponent(sessionId)}/events`,
    { publicUrl: true }
  )
}
