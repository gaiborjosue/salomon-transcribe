"use client"

import { MicVAD } from "@ricky0123/vad-web"
import * as tf from "@tensorflow/tfjs"
import { useCallback, useRef, useState } from "react"

import {
  assessGroqTranslation,
  type GroqTranslationPayload,
} from "@/lib/groq-translation"

type GroqStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "paused"
  | "transcribing"
  | "disconnected"
  | "error"

interface GroqConfig {
  onClassifierFallback?: (details: {
    from: "device"
    reason?: string
    to: "server"
  }) => void
  onPartialTranscript?: (data: { text?: string }) => void
  onFinalTranscript?: (data: { lowConfidence?: boolean; text?: string }) => void
  onError?: (error: Error | Event) => void
}

interface ConnectOptions {
  classifierMode?: "device" | "server"
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

interface GroqRouteResponse extends GroqTranslationPayload {
  metrics?: {
    classifierMs?: number
    decision?: "mixed" | "music" | "speech"
    groqMs?: number
    musicScore?: number
    speechScore?: number
    topLabel?: string
    totalMs?: number
  }
  skipped?: boolean
}

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
const BROWSER_YAMNET_MODEL_URL =
  "https://www.kaggle.com/models/google/yamnet/TfJs/tfjs/1"
const YAMNET_SPEECH_INDICES = [0, 1, 2, 3, 5, 12, 65]
const YAMNET_MUSIC_INDICES = [
  24, 25, 27, 29, 30, 32, 132, 133, 134, 135, 136, 137, 138, 139, 140, 147,
  148, 149, 150, 151, 152, 157, 158, 159, 160, 162, 163, 170, 180, 184, 190,
  209, 211, 212, 214, 222, 225, 228, 229, 232, 234, 235, 238, 240, 241, 242,
  243, 244, 247, 248, 249, 251, 253, 254, 255, 256, 257, 259, 260, 262, 263,
  264, 265, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276,
]
const YAMNET_LABELS: Record<number, string> = {
  0: "Speech",
  2: "Conversation",
  3: "Narration",
  24: "Singing",
  25: "Choir",
  27: "Chant",
  132: "Music",
  249: "Vocal music",
  253: "Christian music",
  254: "Gospel music",
  262: "Background music",
  494: "Silence",
}

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

interface DeviceClassification {
  classifierMs: number
  decision: "mixed" | "music" | "speech"
  musicScore: number
  speechScore: number
  topIndex: number
  topLabel: string
}

let browserYamnetPromise: Promise<tf.GraphModel> | null = null

async function getBrowserYamnetModel() {
  if (!browserYamnetPromise) {
    browserYamnetPromise = (async () => {
      await tf.ready()
      return tf.loadGraphModel(BROWSER_YAMNET_MODEL_URL, { fromTFHub: true })
    })()
  }

  return browserYamnetPromise
}

function sumIndices(data: Float32Array | Float32Array<ArrayBufferLike>, indices: number[]) {
  let sum = 0
  for (const index of indices) {
    sum += data[index] ?? 0
  }
  return sum
}

function shouldSkipForMusic(classification: DeviceClassification) {
  return (
    classification.decision === "music" &&
    classification.musicScore >= 0.32 &&
    classification.speechScore <= 0.12
  )
}

async function classifyOnDevice(samples: Float32Array): Promise<DeviceClassification> {
  const model = await getBrowserYamnetModel()
  const startedAt = performance.now()

  const { meanScores, topIndex } = tf.tidy(() => {
    const waveform = tf.tensor1d(samples)
    const outputs = model.predict(waveform)
    const scoresTensor = Array.isArray(outputs) ? outputs[0] : outputs
    const meanTensor = (scoresTensor as tf.Tensor2D).mean(0)
    const topIndexTensor = meanTensor.argMax()
    const topIndexValue = topIndexTensor.dataSync()[0]
    const scoreValues = Float32Array.from(meanTensor.dataSync())
    return {
      meanScores: scoreValues,
      topIndex: topIndexValue,
    }
  })

  const speechScore = sumIndices(meanScores, YAMNET_SPEECH_INDICES)
  const musicScore = sumIndices(meanScores, YAMNET_MUSIC_INDICES)

  let decision: DeviceClassification["decision"] = "mixed"
  if (musicScore >= 0.32 && speechScore <= 0.12 && musicScore > speechScore * 1.8) {
    decision = "music"
  } else if (speechScore >= 0.18 || speechScore >= musicScore) {
    decision = "speech"
  }

  return {
    classifierMs: performance.now() - startedAt,
    decision,
    musicScore,
    speechScore,
    topIndex,
    topLabel: YAMNET_LABELS[topIndex] || `Class ${topIndex}`,
  }
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
  const activeClassifierModeRef = useRef<"device" | "server">("server")

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

      let deviceClassification: DeviceClassification | null = null
      if (activeClassifierModeRef.current === "device") {
        try {
          deviceClassification = await classifyOnDevice(nextSegment)
          console.info(
            `[Mic][Timing] mode=device classifier=${deviceClassification.classifierMs.toFixed(1)}ms decision=${deviceClassification.decision} top=${deviceClassification.topLabel} speech=${deviceClassification.speechScore.toFixed(3)} music=${deviceClassification.musicScore.toFixed(3)}`
          )

          if (shouldSkipForMusic(deviceClassification)) {
            return
          }

          formData.append("skipServerClassification", "true")
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Unknown error"
          activeClassifierModeRef.current = "server"
          console.warn(
            `[Mic][Classifier] On-device unavailable, falling back to server. ${reason}`
          )
          config.onClassifierFallback?.({
            from: "device",
            reason,
            to: "server",
          })
        }
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

      const payload = (await response.json()) as GroqRouteResponse
      if (payload.metrics) {
        const {
          classifierMs,
          decision,
          groqMs,
          musicScore,
          speechScore,
          topLabel,
          totalMs,
        } = payload.metrics
        console.info(
          `[Mic][Timing] mode=${activeClassifierModeRef.current} skipped=${payload.skipped ? "true" : "false"} classifier=${typeof classifierMs === "number" ? `${classifierMs.toFixed(1)}ms` : "n/a"} groq=${typeof groqMs === "number" ? `${groqMs.toFixed(1)}ms` : "n/a"} total=${typeof totalMs === "number" ? `${totalMs.toFixed(1)}ms` : "n/a"}${decision ? ` decision=${decision}` : ""}${topLabel ? ` top=${topLabel}` : ""}${typeof speechScore === "number" ? ` speech=${speechScore.toFixed(3)}` : ""}${typeof musicScore === "number" ? ` music=${musicScore.toFixed(3)}` : ""}`
        )
      }

      if (payload.skipped) {
        return
      }

      const assessment = assessGroqTranslation(payload)
      const stableText = assessment.text

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
          config.onFinalTranscript?.({
            lowConfidence: assessment.lowConfidence,
            text: dedupedText,
          })
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
    activeClassifierModeRef.current = options.classifierMode ?? "server"

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
