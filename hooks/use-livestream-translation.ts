"use client"

import { useCallback, useRef, useState } from "react"

import type {
  LivestreamMode,
  LivestreamSessionSnapshot,
  LivestreamSessionStatus,
  LivestreamTranscriptEntry,
} from "@/lib/livestream-types"

interface LivestreamConfig {
  onError?: (error: Error | Event) => void
  onFinalTranscript?: (entry: LivestreamTranscriptEntry) => void
  onSnapshot?: (snapshot: LivestreamSessionSnapshot) => void
  onStatusChange?: (payload: {
    error?: string
    sourceTitle?: string
    status: LivestreamSessionStatus
  }) => void
}

interface ConnectOptions {
  streamUrl: string
  transcriptionMode: LivestreamMode
}

interface LivestreamHook {
  connect: (options: ConnectOptions) => Promise<void>
  disconnect: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  sessionId: string | null
  status: LivestreamSessionStatus
}

async function postSessionAction(
  sessionId: string,
  action: "pause" | "resume" | "stop"
) {
  const response = await fetch(`/api/livestreamtest/session/${sessionId}/control`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action }),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : `Livestream ${action} failed with status ${response.status}`
    )
  }
}

export function useLivestreamTranslation(config: LivestreamConfig): LivestreamHook {
  const [status, setStatus] = useState<LivestreamSessionStatus>("idle")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const connectingRef = useRef(false)
  const statusRef = useRef<LivestreamSessionStatus>("idle")

  const updateStatus = useCallback((nextStatus: LivestreamSessionStatus) => {
    statusRef.current = nextStatus
    setStatus(nextStatus)
  }, [])

  const closeEventSource = useCallback(() => {
    eventSourceRef.current?.close()
    eventSourceRef.current = null
  }, [])

  const disconnect = useCallback(async () => {
    const currentSessionId = sessionId
    closeEventSource()
    setSessionId(null)

    if (!currentSessionId) {
      updateStatus("disconnected")
      return
    }

    try {
      await postSessionAction(currentSessionId, "stop")
    } catch (error) {
      if (error instanceof Error || error instanceof Event) {
        config.onError?.(error)
      }
    } finally {
      updateStatus("disconnected")
    }
  }, [closeEventSource, config, sessionId, updateStatus])

  const connect = useCallback(
    async (options: ConnectOptions) => {
      if (connectingRef.current) {
        return
      }

      connectingRef.current = true
      updateStatus("connecting")
      closeEventSource()
      setSessionId(null)

      try {
        const response = await fetch("/api/livestreamtest/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(options),
        })

        if (!response.ok) {
          const payload = await response.json().catch(() => null)
          throw new Error(
            typeof payload?.error === "string"
              ? payload.error
              : `Unable to start livestream session (${response.status}).`
          )
        }

        const payload = (await response.json()) as { sessionId: string }
        setSessionId(payload.sessionId)

        const eventSource = new EventSource(
          `/api/livestreamtest/session/${payload.sessionId}/events`
        )
        eventSourceRef.current = eventSource

        eventSource.addEventListener("snapshot", (event) => {
          const snapshot = JSON.parse(
            (event as MessageEvent<string>).data
          ) as LivestreamSessionSnapshot
          updateStatus(snapshot.status)
          config.onSnapshot?.(snapshot)
        })

        eventSource.addEventListener("segment", (event) => {
          const entry = JSON.parse(
            (event as MessageEvent<string>).data
          ) as LivestreamTranscriptEntry
          config.onFinalTranscript?.(entry)
        })

        eventSource.addEventListener("status", (event) => {
          const nextStatus = JSON.parse((event as MessageEvent<string>).data) as {
            error?: string
            sourceTitle?: string
            status: LivestreamSessionStatus
          }
          updateStatus(nextStatus.status)
          config.onStatusChange?.(nextStatus)
          if (nextStatus.error) {
            config.onError?.(new Error(nextStatus.error))
          }
        })

        eventSource.onerror = (event) => {
          if (
            statusRef.current === "paused" ||
            statusRef.current === "disconnected"
          ) {
            return
          }

          if (eventSource.readyState === EventSource.CLOSED) {
            updateStatus("error")
            config.onError?.(new Error("The livestream connection ended."))
          }
        }
      } catch (error) {
        updateStatus("error")
        if (error instanceof Error || error instanceof Event) {
          config.onError?.(error)
        }
        throw error
      } finally {
        connectingRef.current = false
      }
    },
    [closeEventSource, config, updateStatus]
  )

  const pause = useCallback(async () => {
    if (!sessionId) return
    await postSessionAction(sessionId, "pause")
    updateStatus("paused")
  }, [sessionId, updateStatus])

  const resume = useCallback(async () => {
    if (!sessionId) return
    await postSessionAction(sessionId, "resume")
    updateStatus("connecting")
  }, [sessionId, updateStatus])

  return {
    connect,
    disconnect,
    pause,
    resume,
    sessionId,
    status,
  }
}
