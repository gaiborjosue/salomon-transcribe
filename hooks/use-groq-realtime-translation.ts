"use client"

import { MicVAD } from "@ricky0123/vad-web"
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
    cfRay?: string
    classifierMs?: number
    contextChars?: number
    contextTruncated?: boolean
    decision?: "mixed" | "music" | "speech"
    groqMs?: number
    musicScore?: number
    promptChars?: number
    speechScore?: number
    topLabel?: string
    totalMs?: number
    xGroqRegion?: string
  }
  skipped?: boolean
}

interface MicQueuedSegment {
  audio: Float32Array
  perf: MicSegmentPerf
}

interface MicSegmentPerf {
  callbackDispatchMs?: number
  clientAssessMs?: number
  deviceClassifierMs?: number
  forcedFlush: boolean
  hadCarryover: boolean
  id: string
  mergedPending: boolean
  queueEnqueuedAt?: number
  queueStartedAt?: number
  segmentDurationMs: number
  segmentReadyAt: number
  skipReason?: "device-music" | "server-music"
  source: "speech-end"
  wavEncodeMs?: number
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

type TfModule = typeof import("@tensorflow/tfjs")

let browserTfPromise: Promise<TfModule> | null = null
let browserYamnetPromise: Promise<Awaited<ReturnType<TfModule["loadGraphModel"]>>> | null =
  null
let browserYamnetWarmupPromise: Promise<void> | null = null

async function getBrowserTf() {
  if (!browserTfPromise) {
    browserTfPromise = import("@tensorflow/tfjs")
  }

  return browserTfPromise
}

async function getBrowserYamnetModel() {
  if (!browserYamnetPromise) {
    browserYamnetPromise = (async () => {
      const tf = await getBrowserTf()
      await tf.ready()
      return tf.loadGraphModel(BROWSER_YAMNET_MODEL_URL, { fromTFHub: true })
    })()
  }

  return browserYamnetPromise
}

async function warmBrowserYamnetModel() {
  if (!browserYamnetWarmupPromise) {
    browserYamnetWarmupPromise = (async () => {
      await classifyOnDevice(new Float32Array(16000))
    })().catch((error) => {
      browserYamnetWarmupPromise = null
      throw error
    })
  }

  return browserYamnetWarmupPromise
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

function logMicPerformance(
  perf: MicSegmentPerf,
  details: {
    classifierDecision?: "mixed" | "music" | "speech"
    clientTotalMs: number
    fetchRoundTripMs?: number
    groqMs?: number
    mode: "device" | "server"
    musicScore?: number
    promptChars?: number
    responseSkipped?: boolean
    serverClassifierMs?: number
    serverTotalMs?: number
    speechScore?: number
    status: "aborted" | "completed" | "failed" | "skipped"
    topLabel?: string
    contextChars?: number
    contextTruncated?: boolean
    cfRay?: string
    xGroqRegion?: string
  }
) {
  const queueWaitMs =
    typeof perf.queueStartedAt === "number"
      ? perf.queueStartedAt - perf.segmentReadyAt
      : undefined
  const networkMs =
    typeof details.fetchRoundTripMs === "number" &&
    typeof details.serverTotalMs === "number"
      ? Math.max(0, details.fetchRoundTripMs - details.serverTotalMs)
      : undefined

  console.groupCollapsed(
    `[Mic][Perf][${perf.id}] ${details.status} total=${details.clientTotalMs.toFixed(1)}ms`
  )
  console.table({
    callbackDispatchMs:
      typeof perf.callbackDispatchMs === "number"
        ? Number(perf.callbackDispatchMs.toFixed(1))
        : "n/a",
    clientAssessMs:
      typeof perf.clientAssessMs === "number"
        ? Number(perf.clientAssessMs.toFixed(1))
        : "n/a",
    deviceClassifierMs:
      typeof perf.deviceClassifierMs === "number"
        ? Number(perf.deviceClassifierMs.toFixed(1))
        : "n/a",
    fetchRoundTripMs:
      typeof details.fetchRoundTripMs === "number"
        ? Number(details.fetchRoundTripMs.toFixed(1))
        : "n/a",
    groqMs:
      typeof details.groqMs === "number"
        ? Number(details.groqMs.toFixed(1))
        : "n/a",
    mode: details.mode,
    networkOverheadMs:
      typeof networkMs === "number" ? Number(networkMs.toFixed(1)) : "n/a",
    queueWaitMs:
      typeof queueWaitMs === "number" ? Number(queueWaitMs.toFixed(1)) : "n/a",
    segmentDurationMs: Number(perf.segmentDurationMs.toFixed(1)),
    serverClassifierMs:
      typeof details.serverClassifierMs === "number"
        ? Number(details.serverClassifierMs.toFixed(1))
        : "n/a",
    serverTotalMs:
      typeof details.serverTotalMs === "number"
        ? Number(details.serverTotalMs.toFixed(1))
        : "n/a",
    source: perf.source,
    status: details.status,
    totalClientMs: Number(details.clientTotalMs.toFixed(1)),
    wavEncodeMs:
      typeof perf.wavEncodeMs === "number"
        ? Number(perf.wavEncodeMs.toFixed(1))
        : "n/a",
  })

  console.info("[Mic][Perf][Detail]", {
    cfRay: details.cfRay,
    classifierDecision: details.classifierDecision,
    contextChars: details.contextChars,
    contextTruncated: details.contextTruncated,
    forcedFlush: perf.forcedFlush,
    hadCarryover: perf.hadCarryover,
    mergedPending: perf.mergedPending,
    promptChars: details.promptChars,
    responseSkipped: details.responseSkipped,
    skipReason: perf.skipReason,
    speechScore:
      typeof details.speechScore === "number"
        ? Number(details.speechScore.toFixed(3))
        : undefined,
    musicScore:
      typeof details.musicScore === "number"
        ? Number(details.musicScore.toFixed(3))
        : undefined,
    topLabel: details.topLabel,
    xGroqRegion: details.xGroqRegion,
  })
  console.groupEnd()
}

async function classifyOnDevice(samples: Float32Array): Promise<DeviceClassification> {
  const tf = await getBrowserTf()
  const model = await getBrowserYamnetModel()
  const startedAt = performance.now()

  const { meanScores, topIndex } = tf.tidy(() => {
    const waveform = tf.tensor1d(samples)
    const outputs = model.predict(waveform)
    const scoresTensor = Array.isArray(outputs) ? outputs[0] : outputs
    const meanTensor = (scoresTensor as import("@tensorflow/tfjs").Tensor2D).mean(0)
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
  const audioContextRef = useRef<AudioContext | null>(null)
  const optionsRef = useRef<ConnectOptions | null>(null)
  const activeRef = useRef(false)
  const uploadInFlightRef = useRef(false)
  const segmentQueueRef = useRef<MicQueuedSegment[]>([])
  const forceFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingShortSegmentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSpeakingRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const pendingShortSegmentRef = useRef<Float32Array | null>(null)
  const pendingShortSegmentPerfRef = useRef<MicSegmentPerf | null>(null)
  const carryoverSegmentRef = useRef<Float32Array | null>(null)
  const forcedFlushRequestedRef = useRef(false)
  const committedTranslationsRef = useRef<string[]>([])
  const pausedRef = useRef(false)
  const activeClassifierModeRef = useRef<"device" | "server">("server")
  const segmentPerfCounterRef = useRef(0)
  const pendingInitialStreamRef = useRef<MediaStream | null>(null)

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
    pendingShortSegmentPerfRef.current = null
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
    pendingInitialStreamRef.current?.getTracks().forEach((track) => track.stop())
    pendingInitialStreamRef.current = null

    const vad = vadRef.current
    vadRef.current = null
    const audioContext = audioContextRef.current
    audioContextRef.current = null

    if (vad) {
      void vad.destroy().catch(() => {})
    }

    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => {})
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
    nextSegment.perf.queueStartedAt = performance.now()

    try {
      const wavEncodeStartedAt = performance.now()
      const wavBlob = encodeWav(nextSegment.audio, 16000)
      nextSegment.perf.wavEncodeMs = performance.now() - wavEncodeStartedAt
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
          deviceClassification = await classifyOnDevice(nextSegment.audio)
          nextSegment.perf.deviceClassifierMs = deviceClassification.classifierMs

          if (shouldSkipForMusic(deviceClassification)) {
            nextSegment.perf.skipReason = "device-music"
            logMicPerformance(nextSegment.perf, {
              classifierDecision: deviceClassification.decision,
              clientTotalMs: performance.now() - nextSegment.perf.segmentReadyAt,
              mode: activeClassifierModeRef.current,
              musicScore: deviceClassification.musicScore,
              speechScore: deviceClassification.speechScore,
              status: "skipped",
              topLabel: deviceClassification.topLabel,
            })
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

      const fetchStartedAt = performance.now()
      const response = await fetch("/api/groq-translation", {
        method: "POST",
        body: formData,
        signal: abortController.signal,
      })
      const fetchRoundTripMs = performance.now() - fetchStartedAt

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null)
        throw new Error(
          typeof errorPayload?.error === "string"
            ? errorPayload.error
            : `Groq translation failed with status ${response.status}`
        )
      }

      const payload = (await response.json()) as GroqRouteResponse
      if (payload.skipped) {
        nextSegment.perf.skipReason = "server-music"
        logMicPerformance(nextSegment.perf, {
          cfRay: payload.metrics?.cfRay,
          classifierDecision: payload.metrics?.decision,
          clientTotalMs: performance.now() - nextSegment.perf.segmentReadyAt,
          contextChars: payload.metrics?.contextChars,
          contextTruncated: payload.metrics?.contextTruncated,
          fetchRoundTripMs,
          groqMs: payload.metrics?.groqMs,
          mode: activeClassifierModeRef.current,
          musicScore: payload.metrics?.musicScore,
          promptChars: payload.metrics?.promptChars,
          responseSkipped: true,
          serverClassifierMs: payload.metrics?.classifierMs,
          serverTotalMs: payload.metrics?.totalMs,
          speechScore: payload.metrics?.speechScore,
          status: "skipped",
          topLabel: payload.metrics?.topLabel,
          xGroqRegion: payload.metrics?.xGroqRegion,
        })
        return
      }

      const assessStartedAt = performance.now()
      const assessment = assessGroqTranslation(payload)
      nextSegment.perf.clientAssessMs = performance.now() - assessStartedAt
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
          const callbackStartedAt = performance.now()
          config.onFinalTranscript?.({
            lowConfidence: assessment.lowConfidence,
            text: dedupedText,
          })
          nextSegment.perf.callbackDispatchMs =
            performance.now() - callbackStartedAt
        }
      }

      logMicPerformance(nextSegment.perf, {
        cfRay: payload.metrics?.cfRay,
        classifierDecision: payload.metrics?.decision,
        clientTotalMs: performance.now() - nextSegment.perf.segmentReadyAt,
        contextChars: payload.metrics?.contextChars,
        contextTruncated: payload.metrics?.contextTruncated,
        fetchRoundTripMs,
        groqMs: payload.metrics?.groqMs,
        mode: activeClassifierModeRef.current,
        musicScore: payload.metrics?.musicScore,
        promptChars: payload.metrics?.promptChars,
        responseSkipped: false,
        serverClassifierMs: payload.metrics?.classifierMs,
        serverTotalMs: payload.metrics?.totalMs,
        speechScore: payload.metrics?.speechScore,
        status: "completed",
        topLabel: payload.metrics?.topLabel,
        xGroqRegion: payload.metrics?.xGroqRegion,
      })
    } catch (error) {
      if (abortController.signal.aborted) {
        logMicPerformance(nextSegment.perf, {
          clientTotalMs: performance.now() - nextSegment.perf.segmentReadyAt,
          mode: activeClassifierModeRef.current,
          status: "aborted",
        })
        return
      }

      logMicPerformance(nextSegment.perf, {
        clientTotalMs: performance.now() - nextSegment.perf.segmentReadyAt,
        mode: activeClassifierModeRef.current,
        status: "failed",
      })
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

  const queueSegmentForUpload = useCallback((segment: MicQueuedSegment) => {
    if (!activeRef.current || segment.audio.length === 0) {
      return
    }

    segment.perf.queueEnqueuedAt = performance.now()
    segmentQueueRef.current.push(segment)
    void processQueue()
  }, [processQueue])

  const flushPendingShortSegment = useCallback(() => {
    clearPendingShortTimer()
    const pending = pendingShortSegmentRef.current
    const pendingPerf = pendingShortSegmentPerfRef.current
    pendingShortSegmentRef.current = null
    pendingShortSegmentPerfRef.current = null

    if (pending && pendingPerf) {
      queueSegmentForUpload({
        audio: pending,
        perf: pendingPerf,
      })
    }
  }, [clearPendingShortTimer, queueSegmentForUpload])

  const enqueueSegment = useCallback(
    ({
      audio,
      forcedFlush,
      hadCarryover,
    }: {
      audio: Float32Array
      forcedFlush: boolean
      hadCarryover: boolean
    }) => {
    if (!activeRef.current || audio.length === 0) {
      return
    }

    let nextAudio = audio
    let perf: MicSegmentPerf = {
      forcedFlush,
      hadCarryover,
      id: `seg-${++segmentPerfCounterRef.current}`,
      mergedPending: false,
      segmentDurationMs: getAudioDurationMs(audio, 16000),
      segmentReadyAt: performance.now(),
      source: "speech-end",
    }

    if (pendingShortSegmentRef.current && pendingShortSegmentPerfRef.current) {
      nextAudio = mergeAudioSegments(pendingShortSegmentRef.current, nextAudio)
      perf = {
        ...perf,
        forcedFlush:
          pendingShortSegmentPerfRef.current.forcedFlush || perf.forcedFlush,
        hadCarryover:
          pendingShortSegmentPerfRef.current.hadCarryover || perf.hadCarryover,
        id: `${pendingShortSegmentPerfRef.current.id}+${perf.id}`,
        mergedPending: true,
        segmentDurationMs: getAudioDurationMs(nextAudio, 16000),
        segmentReadyAt: Math.min(
          pendingShortSegmentPerfRef.current.segmentReadyAt,
          perf.segmentReadyAt
        ),
      }
      pendingShortSegmentRef.current = null
      pendingShortSegmentPerfRef.current = null
      clearPendingShortTimer()
    }

    if (forcedFlushRequestedRef.current) {
      carryoverSegmentRef.current = getAudioTail(
        nextAudio,
        FORCED_FLUSH_OVERLAP_MS,
        16000
      )
      forcedFlushRequestedRef.current = false
    }

    const durationMs = getAudioDurationMs(nextAudio, 16000)
    const modeConfig = getModeConfig(optionsRef.current?.transcriptionMode)

    if (!forcedFlush && durationMs < modeConfig.minSegmentDurationMs) {
      pendingShortSegmentRef.current = nextAudio
      pendingShortSegmentPerfRef.current = {
        ...perf,
        segmentDurationMs: durationMs,
      }
      clearPendingShortTimer()
      pendingShortSegmentTimerRef.current = setTimeout(() => {
        flushPendingShortSegment()
      }, modeConfig.shortSegmentFlushDelayMs)
      return
    }

    perf.segmentDurationMs = durationMs
    queueSegmentForUpload({
      audio: nextAudio,
      perf,
    })
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
      const audioContext = audioContextRef.current
      if (audioContext?.state === "suspended") {
        await audioContext.resume()
      }

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
      const connectStartedAt = performance.now()
      const audioContext = new AudioContext({
        latencyHint: "interactive",
      })
      audioContextRef.current = audioContext
      const audioConstraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: options.microphone?.echoCancellation ?? false,
        noiseSuppression: options.microphone?.noiseSuppression ?? false,
        autoGainControl: options.microphone?.autoGainControl ?? true,
      }

      const permissionStartedAt = performance.now()
      let initialStream: MediaStream | null = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      })
      pendingInitialStreamRef.current = initialStream
      const permissionMs = performance.now() - permissionStartedAt

      let classifierWarmupMs: number | undefined
      if (activeClassifierModeRef.current === "device") {
        const warmupStartedAt = performance.now()
        await warmBrowserYamnetModel()
        classifierWarmupMs = performance.now() - warmupStartedAt
      }

      const vad = await MicVAD.new({
        startOnLoad: false,
        baseAssetPath: VAD_ASSET_BASE_PATH,
        onnxWASMBasePath: ORT_WASM_BASE_PATH,
        audioContext,
        model: "v5",
        redemptionMs: getModeConfig(options.transcriptionMode).vadRedemptionMs,
        minSpeechMs: VAD_MIN_SPEECH_MS,
        preSpeechPadMs: VAD_PRE_SPEECH_PAD_MS,
        submitUserSpeechOnPause: true,
        getStream: async () => {
          if (initialStream) {
            const stream = initialStream
            initialStream = null
            pendingInitialStreamRef.current = null
            return stream
          }

          return navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
          })
        },
        onSpeechStart: () => {
          isSpeakingRef.current = true
          scheduleForceFlush()
        },
        onSpeechEnd: async (audio) => {
          isSpeakingRef.current = false
          clearForceFlushTimer()
          const hadCarryover = Boolean(carryoverSegmentRef.current)
          const nextAudio = hadCarryover
            ? mergeAudioSegments(carryoverSegmentRef.current!, audio)
            : audio
          carryoverSegmentRef.current = null
          enqueueSegment({
            audio: nextAudio,
            forcedFlush: forcedFlushRequestedRef.current,
            hadCarryover,
          })
        },
        onVADMisfire: () => {
          isSpeakingRef.current = false
          clearForceFlushTimer()
        },
      })

      vadRef.current = vad
      pausedRef.current = false
      if (audioContext.state === "suspended") {
        await audioContext.resume()
      }
      await vad.start()
      pendingInitialStreamRef.current = null

      if (!activeRef.current) {
        await vad.destroy()
        if (audioContext.state !== "closed") {
          await audioContext.close().catch(() => {})
        }
        audioContextRef.current = null
        return
      }

      console.info(
        `[Mic][Connect] ready total=${(performance.now() - connectStartedAt).toFixed(1)}ms micPermission=${permissionMs.toFixed(1)}ms classifierWarmup=${typeof classifierWarmupMs === "number" ? `${classifierWarmupMs.toFixed(1)}ms` : "n/a"} mode=${activeClassifierModeRef.current}`
      )
      setStatus("connected")
    } catch (error) {
      activeRef.current = false
      pendingInitialStreamRef.current?.getTracks().forEach((track) => track.stop())
      pendingInitialStreamRef.current = null
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
