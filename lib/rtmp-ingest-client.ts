const RTMP_INGEST_BASE_URL =
  process.env.RTMP_INGEST_BASE_URL ?? "http://127.0.0.1:4100"

function getIngestUrl(pathname: string) {
  return new URL(pathname, RTMP_INGEST_BASE_URL).toString()
}

export async function startRtmpIngestSession(payload: {
  appBaseUrl: string
  ingestToken: string
  sessionId: string
  streamKey: string
}) {
  const response = await fetch(getIngestUrl("/sessions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      errorText || `RTMP ingest service failed to start (${response.status}).`
    )
  }
}

export async function stopRtmpIngestSession(sessionId: string) {
  const response = await fetch(getIngestUrl(`/sessions/${sessionId}/stop`), {
    method: "POST",
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      errorText || `RTMP ingest service failed to stop (${response.status}).`
    )
  }
}
