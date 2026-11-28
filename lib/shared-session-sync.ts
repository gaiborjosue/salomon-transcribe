import type { TranscriptEntry } from "@/lib/transcript-types"

interface SharedSessionSyncRequest {
  entries: TranscriptEntry[]
  hostToken: string
  sessionId: string
  sourceTitle?: string
}

async function sendSharedSessionSync({ sessionId, ...payload }: SharedSessionSyncRequest) {
  const response = await fetch(`/api/shared-sessions/${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, type: "sync" }),
  })

  if (!response.ok) {
    const result = await response.json().catch(() => null)
    throw new Error(
      typeof result?.error === "string"
        ? result.error
        : "Unable to sync the shared session."
    )
  }
}

export function createSharedSessionSync(
  send: (request: SharedSessionSyncRequest) => Promise<void> = sendSharedSessionSync
) {
  let pending: SharedSessionSyncRequest | null = null
  let running: Promise<void> | null = null

  const drain = async () => {
    try {
      while (pending) {
        const request = pending
        pending = null
        await send(request)
      }
    } finally {
      running = null
    }
  }

  return (request: SharedSessionSyncRequest) => {
    // Full snapshots replace the stored transcript. Never send them concurrently:
    // a slower, older request could otherwise overwrite the latest live text.
    // While a write is in flight, keep only the newest pending snapshot.
    pending = request
    if (!running) {
      running = Promise.resolve().then(drain)
    }
    return running
  }
}
