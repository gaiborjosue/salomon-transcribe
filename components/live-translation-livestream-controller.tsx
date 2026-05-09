"use client"

import { useEffect } from "react"

import type {
  LivestreamControllerHandle,
  LivestreamControllerStatus,
} from "@/components/live-translation-controller-types"
import { useLivestreamTranslation } from "@/hooks/use-livestream-translation"
import type {
  LivestreamSessionSnapshot,
  LivestreamTranscriptEntry,
} from "@/lib/livestream-types"

export function LiveTranslationLivestreamController({
  controllerRef,
  onError,
  onFinalTranscript,
  onPartialTranscript,
  onSnapshot,
  onStatusChange,
}: {
  controllerRef: React.MutableRefObject<LivestreamControllerHandle | null>
  onError: (error: Error | Event) => void
  onFinalTranscript: (entry: LivestreamTranscriptEntry) => void
  onPartialTranscript: (data: { text?: string }) => void
  onSnapshot: (snapshot: LivestreamSessionSnapshot) => void
  onStatusChange: (payload: {
    error?: string
    sourceTitle?: string
    status: LivestreamControllerStatus
  }) => void
}) {
  const translator = useLivestreamTranslation({
    onError,
    onFinalTranscript,
    onPartialTranscript,
    onSnapshot,
    onStatusChange,
  })

  useEffect(() => {
    controllerRef.current = {
      connect: translator.connect,
      disconnect: translator.disconnect,
      pause: translator.pause,
      resume: translator.resume,
      sessionId: translator.sessionId,
    }

    return () => {
      controllerRef.current = null
    }
  }, [controllerRef, translator])

  useEffect(() => {
    controllerRef.current = controllerRef.current
      ? {
          ...controllerRef.current,
          sessionId: translator.sessionId,
        }
      : null
  }, [controllerRef, translator.sessionId])

  useEffect(() => {
    onStatusChange({ status: translator.status })
  }, [onStatusChange, translator.status])

  return null
}
