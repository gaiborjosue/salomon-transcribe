"use client"

import { MicVAD } from "@ricky0123/vad-web"
import { useCallback, useRef, useState } from "react"

type GroqStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "paused"
  | "transcribing"
  | "disconnected"
  | "error"

interface GroqConfig {
  onPartialTranscript?: (data: { text?: string }) => void
  onFinalTranscript?: (data: { text?: string }) => void
  onError?: (error: Error | Event) => void
}

interface ConnectOptions {
  languageCode?: string
  microphone?: {
    echoCancellation?: boolean
    noiseSuppression?: boolean
    autoGainControl?: boolean
  }
  transcriptionMode?: "conversation" | "sermon"
}

interface GroqHook {
  status: GroqStatus
  connect: (options: ConnectOptions) => Promise<void>
  disconnect: () => void
  clearTranscripts: () => void
  pause: () => Promise<void>
  resume: () => Promise<void>
}

interface GroqSegment {
  text?: string
  start?: number
  end?: number
  avg_logprob?: number
  no_speech_prob?: number
}

const MAX_NO_SPEECH_PROB = 0.6
const MIN_AVG_LOGPROB = -0.9
const MAX_SPEECH_SEGMENT_MS = 12000
const VAD_REDEMPTION_MS = 650
const VAD_MIN_SPEECH_MS = 300
const VAD_PRE_SPEECH_PAD_MS = 500
const FORCED_FLUSH_OVERLAP_MS = 350
const MIN_SEGMENT_DURATION_MS = 850
const SHORT_SEGMENT_FLUSH_DELAY_MS = 900
const MAX_CONTEXT_SEGMENTS = 2
const MIN_WORD_OVERLAP = 2
const MAX_WORD_OVERLAP = 12
const ORT_WASM_BASE_PATH =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/"
const VAD_ASSET_BASE_PATH =
  "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/"

function getModeConfig(mode: ConnectOptions["transcriptionMode"]) {
  if (mode === "sermon") {
    return {
      maxSpeechSegmentMs: 22000,
      minSegmentDurationMs: 1400,
      shortSegmentFlushDelayMs: 1600,
      vadRedemptionMs: 950,
    }
  }

  return {
    maxSpeechSegmentMs: MAX_SPEECH_SEGMENT_MS,
    minSegmentDurationMs: MIN_SEGMENT_DURATION_MS,
    shortSegmentFlushDelayMs: SHORT_SEGMENT_FLUSH_DELAY_MS,
    vadRedemptionMs: VAD_REDEMPTION_MS,
  }
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2
  const blockAlign = bytesPerSample
  const byteRate = sampleRate * blockAlign
  const pcmBuffer = new ArrayBuffer(44 + samples.length * bytesPerSample)
  const view = new DataView(pcmBuffer)

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeString(0, "RIFF")
  view.setUint32(4, 36 + samples.length * bytesPerSample, true)
  writeString(8, "WAVE")
  writeString(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(36, "data")
  view.setUint32(40, samples.length * bytesPerSample, true)

  let offset = 44
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true)
    offset += bytesPerSample
  }

  return new Blob([pcmBuffer], { type: "audio/wav" })
}

function mergeAudioSegments(
  first: Float32Array,
  second: Float32Array
): Float32Array {
  const merged = new Float32Array(first.length + second.length)
  merged.set(first, 0)
  merged.set(second, first.length)
  return merged
}

function getAudioDurationMs(samples: Float32Array, sampleRate: number): number {
  return (samples.length / sampleRate) * 1000
}

function getAudioTail(
  samples: Float32Array,
  durationMs: number,
  sampleRate: number
): Float32Array {
  const tailLength = Math.min(
    samples.length,
    Math.round((durationMs / 1000) * sampleRate)
  )

  return tailLength > 0 ? samples.slice(samples.length - tailLength) : new Float32Array()
}

function shouldKeepSegment(segment: GroqSegment, text: string): boolean {
  if (!text) {
    return false
  }

  if (
    typeof segment.no_speech_prob === "number" &&
    segment.no_speech_prob > MAX_NO_SPEECH_PROB
  ) {
    return false
  }

  if (
    typeof segment.avg_logprob === "number" &&
    segment.avg_logprob < MIN_AVG_LOGPROB
  ) {
    return false
  }

  return true
}

function getStableText(payload: unknown): string {
  const topLevelText =
    payload &&
    typeof payload === "object" &&
    typeof (payload as { text?: string }).text === "string"
      ? normalizeWhitespace((payload as { text: string }).text)
      : ""

  if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { segments?: GroqSegment[] }).segments)
  ) {
    const segments = (payload as { segments: GroqSegment[] }).segments
    const stableSegments = segments
      .map((segment) => {
        const text = normalizeWhitespace(typeof segment.text === "string" ? segment.text : "")
        return shouldKeepSegment(segment, text) ? text : ""
      })
      .filter(Boolean)

    if (stableSegments.length > 0) {
      return topLevelText || normalizeWhitespace(stableSegments.join(" "))
    }
  }

  return topLevelText
}

function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "")
}

function dedupeBoundaryText(previousText: string, nextText: string): string {
  const trimmedNextText = normalizeWhitespace(nextText)

  if (!previousText || !trimmedNextText) {
    return trimmedNextText
  }

  const previousWords = normalizeWhitespace(previousText).split(" ")
  const nextWords = trimmedNextText.split(" ")
  const comparablePrevious = previousWords.map(normalizeWord)
  const comparableNext = nextWords.map(normalizeWord)

  const maxOverlap = Math.min(
    MAX_WORD_OVERLAP,
    comparablePrevious.length,
    comparableNext.length
  )

  for (let overlap = maxOverlap; overlap >= MIN_WORD_OVERLAP; overlap--) {
    const previousSlice = comparablePrevious.slice(-overlap)
    const nextSlice = comparableNext.slice(0, overlap)

    if (
      previousSlice.every(
        (word, index) => word.length > 0 && word === nextSlice[index]
      )
    ) {
      return normalizeWhitespace(nextWords.slice(overlap).join(" "))
    }
  }

  return trimmedNextText
}

export function useGroqRealtimeTranslation(config: GroqConfig): GroqHook {
  const [status, setStatus] = useState<GroqStatus>("idle")
  const vadRef = useRef<MicVAD | null>(null)
  const optionsRef = useRef<ConnectOptions | null>(null)
  const activeRef = useRef(false)
  const uploadInFlightRef = useRef(false)
  const segmentQueueRef = useRef<Float32Array[]>([])
  const forceFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingShortSegmentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSpeakingRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const pendingShortSegmentRef = useRef<Float32Array | null>(null)
  const carryoverSegmentRef = useRef<Float32Array | null>(null)
  const forcedFlushRequestedRef = useRef(false)
  const committedTranslationsRef = useRef<string[]>([])
  const pausedRef = useRef(false)

  const clearForceFlushTimer = useCallback(() => {
    if (forceFlushTimerRef.current) {
      clearTimeout(forceFlushTimerRef.current)
      forceFlushTimerRef.current = null
    }
  }, [])

  const clearPendingShortTimer = useCallback(() => {
    if (pendingShortSegmentTimerRef.current) {
      clearTimeout(pendingShortSegmentTimerRef.current)
      pendingShortSegmentTimerRef.current = null
    }
  }, [])

  const clearTranscripts = useCallback(() => {
    segmentQueueRef.current = []
    pendingShortSegmentRef.current = null
    carryoverSegmentRef.current = null
    committedTranslationsRef.current = []
  }, [])

  const teardownCurrentSession = useCallback(() => {
    activeRef.current = false
    isSpeakingRef.current = false
    pausedRef.current = false
    forcedFlushRequestedRef.current = false
    clearForceFlushTimer()
    clearPendingShortTimer()
    clearTranscripts()
    abortControllerRef.current?.abort()
    abortControllerRef.current = null

    const vad = vadRef.current
    vadRef.current = null

    if (vad) {
      void vad.destroy().catch(() => {})
    }

    uploadInFlightRef.current = false
  }, [clearForceFlushTimer, clearPendingShortTimer, clearTranscripts])

  const processQueue = useCallback(async () => {
    if (!activeRef.current || uploadInFlightRef.current) {
      return
    }

    if (pausedRef.current) {
      return
    }

    const nextSegment = segmentQueueRef.current.shift()
    if (!nextSegment) {
      return
    }

    uploadInFlightRef.current = true
    setStatus("transcribing")
    const abortController = new AbortController()
    abortControllerRef.current = abortController

    try {
      const wavBlob = encodeWav(nextSegment, 16000)
      const formData = new FormData()
      formData.append("audio", wavBlob, "segment.wav")
      const recentContext = committedTranslationsRef.current
        .slice(-MAX_CONTEXT_SEGMENTS)
        .join(" ")
        .trim()

      if (recentContext) {
        formData.append("context", recentContext)
      }

      if (optionsRef.current?.languageCode) {
        formData.append("sourceLanguage", optionsRef.current.languageCode)
      }

      const response = await fetch("/api/groq-translation", {
        method: "POST",
        body: formData,
        signal: abortController.signal,
      })

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null)
        throw new Error(
          typeof errorPayload?.error === "string"
            ? errorPayload.error
            : `Groq translation failed with status ${response.status}`
        )
      }

      const payload = await response.json()
      const stableText = getStableText(payload)

      if (stableText) {
        const previousText =
          committedTranslationsRef.current[
            committedTranslationsRef.current.length - 1
          ] || ""
        const dedupedText = dedupeBoundaryText(previousText, stableText)

        if (dedupedText) {
          committedTranslationsRef.current = [
            ...committedTranslationsRef.current,
            dedupedText,
          ]
          config.onFinalTranscript?.({ text: dedupedText })
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        return
      }

      setStatus("error")
      if (error instanceof Error || error instanceof Event) {
        config.onError?.(error)
      }
      return
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null
      }

      uploadInFlightRef.current = false
      if (activeRef.current) {
        if (pausedRef.current) {
          setStatus("paused")
          return
        }
        setStatus("connected")
      }
    }

    if (segmentQueueRef.current.length > 0) {
      void processQueue()
    }
  }, [config])

  const queueSegmentForUpload = useCallback((audio: Float32Array) => {
    if (!activeRef.current || audio.length === 0) {
      return
    }

    segmentQueueRef.current.push(audio)
    void processQueue()
  }, [processQueue])

  const flushPendingShortSegment = useCallback(() => {
    clearPendingShortTimer()
    const pending = pendingShortSegmentRef.current
    pendingShortSegmentRef.current = null

    if (pending) {
      queueSegmentForUpload(pending)
    }
  }, [clearPendingShortTimer, queueSegmentForUpload])

  const enqueueSegment = useCallback((audio: Float32Array) => {
    if (!activeRef.current || audio.length === 0) {
      return
    }

    let nextAudio = audio

    if (pendingShortSegmentRef.current) {
      nextAudio = mergeAudioSegments(pendingShortSegmentRef.current, nextAudio)
      pendingShortSegmentRef.current = null
      clearPendingShortTimer()
    }

    const forcedFlushRequested = forcedFlushRequestedRef.current
    if (forcedFlushRequested) {
      carryoverSegmentRef.current = getAudioTail(
        nextAudio,
        FORCED_FLUSH_OVERLAP_MS,
        16000
      )
      forcedFlushRequestedRef.current = false
    }

    const durationMs = getAudioDurationMs(nextAudio, 16000)
    const modeConfig = getModeConfig(optionsRef.current?.transcriptionMode)

    if (!forcedFlushRequested && durationMs < modeConfig.minSegmentDurationMs) {
      pendingShortSegmentRef.current = nextAudio
      clearPendingShortTimer()
      pendingShortSegmentTimerRef.current = setTimeout(() => {
        flushPendingShortSegment()
      }, modeConfig.shortSegmentFlushDelayMs)
      return
    }

    queueSegmentForUpload(nextAudio)
  }, [clearPendingShortTimer, flushPendingShortSegment, queueSegmentForUpload])

  const restartAfterForcedPause = useCallback(async () => {
    const vad = vadRef.current
    if (!vad || !activeRef.current) {
      return
    }

    try {
      await vad.pause()
      if (activeRef.current) {
        await vad.start()
      }
    } catch (error) {
      setStatus("error")
      if (error instanceof Error || error instanceof Event) {
        config.onError?.(error)
      }
    }
  }, [config])

  const scheduleForceFlush = useCallback(() => {
    clearForceFlushTimer()

    forceFlushTimerRef.current = setTimeout(() => {
      if (!isSpeakingRef.current) {
        return
      }

      forcedFlushRequestedRef.current = true
      void restartAfterForcedPause()
    }, getModeConfig(optionsRef.current?.transcriptionMode).maxSpeechSegmentMs)
  }, [clearForceFlushTimer, restartAfterForcedPause])

  const disconnect = useCallback(() => {
    teardownCurrentSession()
    setStatus("disconnected")
  }, [teardownCurrentSession])

  const pause = useCallback(async () => {
    const vad = vadRef.current
    if (!vad || !activeRef.current || pausedRef.current) {
      return
    }

    pausedRef.current = true
    isSpeakingRef.current = false
    clearForceFlushTimer()
    clearPendingShortTimer()
    forcedFlushRequestedRef.current = false

    try {
      await vad.pause()
      setStatus("paused")
    } catch (error) {
      pausedRef.current = false
      setStatus("error")
      if (error instanceof Error || error instanceof Event) {
        config.onError?.(error)
      }
      throw error
    }
  }, [clearForceFlushTimer, clearPendingShortTimer, config])

  const resume = useCallback(async () => {
    const vad = vadRef.current
    if (!vad || !activeRef.current || !pausedRef.current) {
      return
    }

    try {
      await vad.start()
      pausedRef.current = false
      setStatus("connected")
      if (segmentQueueRef.current.length > 0) {
        void processQueue()
      }
    } catch (error) {
      setStatus("error")
      if (error instanceof Error || error instanceof Event) {
        config.onError?.(error)
      }
      throw error
    }
  }, [config, processQueue])

  const connect = useCallback(async (options: ConnectOptions) => {
    setStatus("connecting")
    optionsRef.current = options
    teardownCurrentSession()

    activeRef.current = true
    optionsRef.current = options

    try {
      const vad = await MicVAD.new({
        startOnLoad: false,
        baseAssetPath: VAD_ASSET_BASE_PATH,
        onnxWASMBasePath: ORT_WASM_BASE_PATH,
        redemptionMs: getModeConfig(options.transcriptionMode).vadRedemptionMs,
        minSpeechMs: VAD_MIN_SPEECH_MS,
        preSpeechPadMs: VAD_PRE_SPEECH_PAD_MS,
        submitUserSpeechOnPause: true,
        getStream: async () =>
          navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: options.microphone?.echoCancellation ?? false,
              noiseSuppression: options.microphone?.noiseSuppression ?? false,
              autoGainControl: options.microphone?.autoGainControl ?? true,
            },
          }),
        onSpeechStart: () => {
          isSpeakingRef.current = true
          scheduleForceFlush()
        },
        onSpeechEnd: async (audio) => {
          isSpeakingRef.current = false
          clearForceFlushTimer()
          const nextAudio = carryoverSegmentRef.current
            ? mergeAudioSegments(carryoverSegmentRef.current, audio)
            : audio
          carryoverSegmentRef.current = null
          enqueueSegment(nextAudio)
        },
        onVADMisfire: () => {
          isSpeakingRef.current = false
          clearForceFlushTimer()
        },
      })

      vadRef.current = vad
      pausedRef.current = false
      await vad.start()

      if (!activeRef.current) {
        await vad.destroy()
        return
      }

      setStatus("connected")
    } catch (error) {
      activeRef.current = false
      setStatus("error")

      if (error instanceof Error || error instanceof Event) {
        config.onError?.(error)
      }

      throw error
    }
  }, [
    clearForceFlushTimer,
    config,
    enqueueSegment,
    scheduleForceFlush,
    teardownCurrentSession,
  ])

  return {
    status,
    connect,
    disconnect,
    clearTranscripts,
    pause,
    resume,
  }
}
