"use client"

import { useImperativeHandle } from "react"

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
  const { connect, disconnect, control } = useLivestreamTranslation({
    onError,
    onFinalTranscript,
    onPartialTranscript,
    onSnapshot,
    onStatusChange,
  })

  useImperativeHandle(controllerRef, () => ({
    connect,
    disconnect,
    pause: () => control("pause"),
    resume: () => control("resume"),
  }), [connect, disconnect, control])

  return null
}
