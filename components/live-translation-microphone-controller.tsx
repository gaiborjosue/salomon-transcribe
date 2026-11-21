"use client"

import { MicrophoneSource } from "@soniox/client"
import { useRecording } from "@soniox/react"
import { useEffect, useMemo, useRef, useState } from "react"

import type {
  MicControllerStatus,
  MicrophoneControllerHandle,
} from "@/components/live-translation-controller-types"
import {
  SONIOX_STREAM_ROTATE_AFTER_MS,
  SONIOX_TRANSLATION_CONFIG,
  SonioxTranslationBuffer,
} from "@/lib/soniox-translation"

async function fetchSonioxConfig() {
  const response = await fetch("/api/soniox-token", { method: "POST" })
  const payload = (await response.json().catch(() => null)) as
    | { api_key?: string; error?: string }
    | null

  if (!response.ok || !payload?.api_key) {
    throw new Error(payload?.error || "Unable to connect to Soniox.")
  }
  return { api_key: payload.api_key }
}

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
  const startup = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null)
  const [translation] = useState(() => new SonioxTranslationBuffer())
  const paused = useRef(false)
  const stopping = useRef(false)
  const rotation = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const source = useMemo(() => new MicrophoneSource({
    constraints: {
      autoGainControl: true,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      sampleRate: 16_000,
    },
  }), [])

  function commitTranslation() {
    const text = translation.takeFinal()
    if (text) onFinalTranscript({ text })
    onPartialTranscript({ text: "" })
  }

  const { cancel, pause, reconnect, resume, start, stop } = useRecording({
    ...SONIOX_TRANSLATION_CONFIG,
    config: fetchSonioxConfig,
    source,
    auto_reconnect: true,
    reset_transcript_on_reconnect: true,
    onResult(result) {
      const text = translation.update(result)
      if (result.tokens.length) {
        onPartialTranscript({ text })
        if (text && !paused.current && !stopping.current) onStatusChange("transcribing")
      }
    },
    onEndpoint() {
      commitTranslation()
      if (!paused.current && !stopping.current) onStatusChange("connected")
    },
    onFinalized: commitTranslation,
    onConnected() {
      clearTimeout(rotation.current)
      rotation.current = setTimeout(reconnect, SONIOX_STREAM_ROTATE_AFTER_MS)
    },
    onFinished() {
      clearTimeout(rotation.current)
      commitTranslation()
    },
    onError(error) {
      clearTimeout(rotation.current)
      startup.current?.reject(error)
      startup.current = null
      commitTranslation()
      onError(error)
      if (!stopping.current) onStatusChange("error")
    },
    onReconnecting() {
      commitTranslation()
      onStatusChange("connecting")
    },
    onStateChange({ new_state }) {
      if (new_state === "recording") {
        paused.current = false
        startup.current?.resolve()
        startup.current = null
        onStatusChange("connected")
      } else if (new_state === "paused") {
        paused.current = true
        onStatusChange("paused")
      } else if (new_state === "stopped" && !stopping.current) {
        onStatusChange("disconnected")
      }
    },
  })

  useEffect(() => {
    controllerRef.current = {
      connect: () => {
        paused.current = false
        stopping.current = false
        translation.takeFinal()
        const pending = new Promise<void>((resolve, reject) => {
          startup.current = { resolve, reject }
        })
        start()
        return pending
      },
      async disconnect() {
        stopping.current = true
        clearTimeout(rotation.current)
        if (startup.current) {
          startup.current.reject(new Error("Microphone connection canceled."))
          startup.current = null
          cancel()
          return
        }
        const timeout = setTimeout(cancel, 5_000)
        try {
          await stop()
        } finally {
          clearTimeout(timeout)
        }
      },
      pause,
      resume,
    }

    return () => {
      clearTimeout(rotation.current)
      startup.current?.reject(new Error("Microphone connection canceled."))
      startup.current = null
      controllerRef.current = null
    }
  }, [cancel, controllerRef, pause, resume, start, stop, translation])

  return null
}
