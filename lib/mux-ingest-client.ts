const RTMP_INGEST_BASE_URL =
  process.env.RTMP_INGEST_BASE_URL ?? "http://127.0.0.1:4100"

function getIngestUrl(pathname: string) {
  return new URL(pathname, RTMP_INGEST_BASE_URL).toString()
}

export async function startMuxIngestSession(payload: {
  appBaseUrl: string
  ingestToken: string
  playbackUrl: string
  sessionId: string
}) {
  const response = await fetch(getIngestUrl("/mux-sessions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      errorText || `Mux ingest service failed to start (${response.status}).`
    )
  }
}

export async function stopMuxIngestSession(sessionId: string) {
  const response = await fetch(getIngestUrl(`/mux-sessions/${sessionId}/stop`), {
    method: "POST",
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      errorText || `Mux ingest service failed to stop (${response.status}).`
    )
  }
}
