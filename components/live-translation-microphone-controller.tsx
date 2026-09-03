"use client"

import { useEffect } from "react"

import type {
  MicControllerStatus,
  MicrophoneControllerHandle,
} from "@/components/live-translation-controller-types"
import { useQwenRealtimeTranslation } from "@/hooks/use-qwen-realtime-translation"

export function LiveTranslationMicrophoneController({
  controllerRef,
  onError,
  onFinalTranscript,
  onPartialTranscript,
  onStatusChange,
}: {
  controllerRef: React.MutableRefObject<MicrophoneControllerHandle | null>
  onError: (error: Error | Event) => void
  onFinalTranscript: (data: { lowConfidence?: boolean; text?: string }) => void
  onPartialTranscript: (data: { text?: string }) => void
  onStatusChange: (status: MicControllerStatus) => void
}) {
  const translator = useQwenRealtimeTranslation({
    onError,
    onFinalTranscript,
    onPartialTranscript,
  })

  useEffect(() => {
    controllerRef.current = {
      clearTranscripts: translator.clearTranscripts,
      connect: translator.connect,
      disconnect: translator.disconnect,
      pause: translator.pause,
      resume: translator.resume,
    }

    return () => {
      controllerRef.current = null
    }
  }, [controllerRef, translator])

  useEffect(() => {
    onStatusChange(translator.status)
  }, [onStatusChange, translator.status])

  return null
}
