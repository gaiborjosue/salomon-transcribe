"use client"

import { useImperativeHandle } from "react"

import type {
  LivestreamControllerHandle,
  LivestreamControllerStatus,
} from "@/components/live-translation-controller-types"
import { useLivestreamTranslation } from "@/hooks/use-livestream-translation"
import type { LivestreamSessionSnapshot } from "@/lib/livestream-types"
import type { TranscriptCaption, TranscriptEntry } from "@/lib/transcript-types"

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
  onFinalTranscript: (entry: TranscriptEntry) => void
  onPartialTranscript: (captions: TranscriptCaption[]) => void
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
