"use client"

import { useCallback, useEffect, useRef } from "react"

import type {
  LivestreamSessionSnapshot,
  LivestreamSessionStatus,
} from "@/lib/livestream-types"
import type { TranscriptCaption, TranscriptEntry } from "@/lib/transcript-types"

type LivestreamStatusUpdate = {
  error?: string
  sourceTitle?: string
  status: LivestreamSessionStatus
}

interface LivestreamConfig {
  onError?: (error: Error | Event) => void
  onFinalTranscript?: (entry: TranscriptEntry) => void
  onPartialTranscript?: (captions: TranscriptCaption[]) => void
  onSnapshot?: (snapshot: LivestreamSessionSnapshot) => void
  onStatusChange?: (payload: LivestreamStatusUpdate) => void
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

  const result = (await response.json()) as { snapshot?: LivestreamSessionSnapshot }
  return result.snapshot
}

export function useLivestreamTranslation(config: LivestreamConfig) {
  const callbacks = useRef(config)
  const eventSourceRef = useRef<EventSource | null>(null)
  const connectingRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const requestGeneration = useRef(0)
  const receivedEntries = useRef(new Set<string>())
  const statusRef = useRef<LivestreamSessionStatus>("idle")

  useEffect(() => {
    callbacks.current = config
  }, [config])

  const updateStatus = useCallback((payload: LivestreamStatusUpdate) => {
    statusRef.current = payload.status
    callbacks.current.onStatusChange?.(payload)
  }, [])

  const closeEventSource = useCallback(() => {
    eventSourceRef.current?.close()
    eventSourceRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      requestGeneration.current += 1
      closeEventSource()
    }
  }, [closeEventSource])

  const disconnect = useCallback(async () => {
    requestGeneration.current += 1
    connectingRef.current = false
    const currentSessionId = sessionIdRef.current
    sessionIdRef.current = null
    closeEventSource()

    if (!currentSessionId) {
      updateStatus({ status: "disconnected" })
      return
    }

    try {
      const snapshot = await postSessionAction(currentSessionId, "stop")
      for (const entry of snapshot?.segments ?? []) {
        if (!receivedEntries.current.has(entry.id)) {
          callbacks.current.onFinalTranscript?.(entry)
        }
      }
    } catch (error) {
      if (error instanceof Error || error instanceof Event) {
        callbacks.current.onError?.(error)
      }
    } finally {
      updateStatus({ status: "disconnected" })
    }
  }, [closeEventSource, updateStatus])

  const connect = useCallback(
    async (streamUrl: string) => {
      if (connectingRef.current || sessionIdRef.current) {
        return
      }

      connectingRef.current = true
      const generation = ++requestGeneration.current
      receivedEntries.current.clear()
      updateStatus({ status: "connecting" })
      closeEventSource()

      try {
        const response = await fetch("/api/livestreamtest/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ streamUrl }),
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
        if (generation !== requestGeneration.current) {
          await postSessionAction(payload.sessionId, "stop")
          return
        }
        sessionIdRef.current = payload.sessionId

        const eventSource = new EventSource(
          `/api/livestreamtest/session/${payload.sessionId}/events`
        )
        eventSourceRef.current = eventSource

        eventSource.addEventListener("snapshot", (event) => {
          const snapshot = JSON.parse(
            (event as MessageEvent<string>).data
          ) as LivestreamSessionSnapshot
          receivedEntries.current = new Set(snapshot.segments.map((entry) => entry.id))
          callbacks.current.onSnapshot?.(snapshot)
          updateStatus({
            status: snapshot.status,
            error: snapshot.error,
            sourceTitle: snapshot.sourceTitle,
          })
          if (snapshot.status === "error" || snapshot.status === "disconnected") {
            sessionIdRef.current = null
            closeEventSource()
          }
        })

        eventSource.addEventListener("segment", (event) => {
          const entry = JSON.parse(
            (event as MessageEvent<string>).data
          ) as TranscriptEntry
          if (!receivedEntries.current.has(entry.id)) {
            receivedEntries.current.add(entry.id)
            callbacks.current.onFinalTranscript?.(entry)
          }
        })

        eventSource.addEventListener("partial", (event) => {
          const payload = JSON.parse(
            (event as MessageEvent<string>).data
          ) as { captions?: TranscriptCaption[]; text?: string }
          callbacks.current.onPartialTranscript?.(
            payload.captions ?? (payload.text ? [{ text: payload.text }] : [])
          )
        })

        eventSource.addEventListener("status", (event) => {
          const nextStatus = JSON.parse((event as MessageEvent<string>).data) as LivestreamStatusUpdate
          updateStatus(nextStatus)
          if (nextStatus.error) {
            callbacks.current.onError?.(new Error(nextStatus.error))
          }
          if (nextStatus.status === "error" || nextStatus.status === "disconnected") {
            sessionIdRef.current = null
            closeEventSource()
          }
        })

        eventSource.onerror = () => {
          if (
            statusRef.current === "paused" ||
            statusRef.current === "disconnected"
          ) {
            return
          }

          if (eventSource.readyState === EventSource.CLOSED) {
            sessionIdRef.current = null
            updateStatus({ status: "error" })
            callbacks.current.onError?.(new Error("The livestream connection ended."))
          }
        }
      } catch (error) {
        if (generation !== requestGeneration.current) return
        updateStatus({ status: "error" })
        if (error instanceof Error || error instanceof Event) {
          callbacks.current.onError?.(error)
        }
        throw error
      } finally {
        if (generation === requestGeneration.current) connectingRef.current = false
      }
    },
    [closeEventSource, updateStatus]
  )

  const control = useCallback(async (action: "pause" | "resume") => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return

    try {
      await postSessionAction(sessionId, action)
    } catch (error) {
      if (sessionId === sessionIdRef.current && error instanceof Error) {
        callbacks.current.onError?.(error)
      }
    }
  }, [])

  return { connect, disconnect, control }
}
