"use client"

import { MicVAD } from "@ricky0123/vad-web"
import { useCallback, useRef, useState } from "react"

type QwenRealtimeStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "paused"
  | "transcribing"
  | "disconnected"
  | "error"

interface QwenRealtimeConfig {
  onError?: (error: Error | Event) => void
  onFinalTranscript?: (data: { lowConfidence?: boolean; text?: string }) => void
  onPartialTranscript?: (data: { text?: string }) => void
}

interface ConnectOptions {
  languageCode?: string
  microphone?: {
    autoGainControl?: boolean
    echoCancellation?: boolean
    noiseSuppression?: boolean
  }
  targetLanguage?: string
}

interface QwenRealtimeHook {
  clearTranscripts: () => void
  connect: (options: ConnectOptions) => Promise<void>
  disconnect: () => void
  pause: () => Promise<void>
  resume: () => Promise<void>
  status: QwenRealtimeStatus
}

const TARGET_SAMPLE_RATE = 16_000
const PCM_FLUSH_INTERVAL_MS = 100
const TARGET_PCM_CHUNK_BYTES = 3200
const LOCAL_VAD_REDEMPTION_MS = 700
const LOCAL_VAD_MIN_SPEECH_MS = 250
const LOCAL_VAD_PRE_SPEECH_PAD_MS = 350
const LOCAL_VAD_HANGOVER_MS = 850
const LOCAL_VAD_BUFFER_FRAME_LIMIT = 6
const ORT_WASM_BASE_PATH =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/"
const VAD_ASSET_BASE_PATH =
  "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/"

function float32ToPcm16Buffer(samples: Float32Array) {
  const pcmData = new Int16Array(samples.length)

  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    pcmData[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }

  return pcmData.buffer
}

function resamplePcmFallback(inputData: Float32Array, sourceRate: number) {
  if (sourceRate === TARGET_SAMPLE_RATE) {
    return inputData
  }

  const ratio = sourceRate / TARGET_SAMPLE_RATE
  const outputLength = Math.floor(inputData.length / ratio)
  const output = new Float32Array(outputLength)

  for (let index = 0; index < outputLength; index++) {
    const sourceIndex = index * ratio
    const floorIndex = Math.floor(sourceIndex)
    const ceilIndex = Math.min(floorIndex + 1, inputData.length - 1)
    const interpolation = sourceIndex - floorIndex
    output[index] =
      inputData[floorIndex] * (1 - interpolation) +
      inputData[ceilIndex] * interpolation
  }

  return output
}

export function useQwenRealtimeTranslation(
  config: QwenRealtimeConfig
): QwenRealtimeHook {
  const [status, setStatus] = useState<QwenRealtimeStatus>("idle")

  const wsRef = useRef<WebSocket | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const mediaWorkletNodeRef = useRef<AudioWorkletNode | null>(null)
  const mediaProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const vadRef = useRef<MicVAD | null>(null)
  const activeRef = useRef(false)
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hangoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingInitialStreamRef = useRef<MediaStream | null>(null)
  const pausedRef = useRef(false)
  const localGateOpenRef = useRef(false)
  const pendingAudioBytesRef = useRef(0)
  const pendingAudioChunksRef = useRef<ArrayBuffer[]>([])
  const preRollAudioChunksRef = useRef<ArrayBuffer[]>([])
  const lastPartialRef = useRef("")

  const clearTranscripts = useCallback(() => {
    lastPartialRef.current = ""
  }, [])

  const clearPendingAudio = useCallback(() => {
    pendingAudioBytesRef.current = 0
    pendingAudioChunksRef.current = []
  }, [])

  const clearPreRollAudio = useCallback(() => {
    preRollAudioChunksRef.current = []
  }, [])

  const clearFlushTimer = useCallback(() => {
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current)
      flushTimerRef.current = null
    }
  }, [])

  const clearHangoverTimer = useCallback(() => {
    if (hangoverTimerRef.current) {
      clearTimeout(hangoverTimerRef.current)
      hangoverTimerRef.current = null
    }
  }, [])

  const flushPendingAudio = useCallback(() => {
    const socket = wsRef.current
    if (
      !activeRef.current ||
      pausedRef.current ||
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      pendingAudioBytesRef.current === 0
    ) {
      return
    }

    const merged = new Uint8Array(pendingAudioBytesRef.current)
    let offset = 0

    for (const chunk of pendingAudioChunksRef.current) {
      const view = new Uint8Array(chunk)
      merged.set(view, offset)
      offset += view.byteLength
    }

    clearPendingAudio()
    socket.send(merged.buffer)
  }, [clearPendingAudio])

  const openLocalGate = useCallback(() => {
    clearHangoverTimer()
    localGateOpenRef.current = true

    if (preRollAudioChunksRef.current.length > 0) {
      pendingAudioChunksRef.current.push(...preRollAudioChunksRef.current)
      pendingAudioBytesRef.current += preRollAudioChunksRef.current.reduce(
        (total, chunk) => total + chunk.byteLength,
        0
      )
      clearPreRollAudio()
    }

    flushPendingAudio()
  }, [clearHangoverTimer, clearPreRollAudio, flushPendingAudio])

  const scheduleLocalGateClose = useCallback(() => {
    clearHangoverTimer()
    hangoverTimerRef.current = setTimeout(() => {
      localGateOpenRef.current = false
      clearPreRollAudio()
    }, LOCAL_VAD_HANGOVER_MS)
  }, [clearHangoverTimer, clearPreRollAudio])

  const teardown = useCallback(() => {
    activeRef.current = false
    pausedRef.current = false
    localGateOpenRef.current = false
    clearTranscripts()
    clearFlushTimer()
    clearHangoverTimer()
    clearPendingAudio()
    clearPreRollAudio()

    if (mediaProcessorRef.current) {
      mediaProcessorRef.current.onaudioprocess = null
      try {
        mediaProcessorRef.current.disconnect()
      } catch {
        // noop
      }
      mediaProcessorRef.current = null
    }

    const vad = vadRef.current
    vadRef.current = null
    if (vad) {
      void vad.destroy().catch(() => {})
    }

    if (mediaWorkletNodeRef.current) {
      mediaWorkletNodeRef.current.port.onmessage = null
      try {
        mediaWorkletNodeRef.current.disconnect()
      } catch {
        // noop
      }
      mediaWorkletNodeRef.current = null
    }

    if (mediaSourceRef.current) {
      try {
        mediaSourceRef.current.disconnect()
      } catch {
        // noop
      }
      mediaSourceRef.current = null
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null
    pendingInitialStreamRef.current?.getTracks().forEach((track) => track.stop())
    pendingInitialStreamRef.current = null

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close().catch(() => {})
    }
    audioContextRef.current = null

    if (wsRef.current) {
      try {
        wsRef.current.close()
      } catch {
        // noop
      }
      wsRef.current = null
    }
  }, [
    clearFlushTimer,
    clearHangoverTimer,
    clearPendingAudio,
    clearPreRollAudio,
    clearTranscripts,
  ])

  const disconnect = useCallback(() => {
    const socket = wsRef.current
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action: "stop", type: "control" }))
    }
    teardown()
    setStatus("disconnected")
  }, [teardown])

  const connect = useCallback(
    async (options: ConnectOptions) => {
      teardown()
      setStatus("connecting")

      try {
        const tokenResponse = await fetch("/api/qwen-live-token", {
          body: JSON.stringify({
            sourceLanguage: options.languageCode || "es",
            targetLanguage: options.targetLanguage || "en",
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        })

        const tokenPayload = (await tokenResponse.json().catch(() => null)) as
          | { error?: string; wsUrl?: string }
          | null

        if (!tokenResponse.ok || !tokenPayload?.wsUrl) {
          throw new Error(
            typeof tokenPayload?.error === "string"
              ? tokenPayload.error
              : "Unable to open the Qwen realtime socket."
          )
        }

        if (
          window.location.protocol === "https:" &&
          tokenPayload.wsUrl.startsWith("ws://")
        ) {
          throw new Error(
            "Live mic is configured with an insecure WebSocket URL. Use a wss:// ingest URL for production."
          )
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: options.microphone?.autoGainControl ?? true,
            echoCancellation: options.microphone?.echoCancellation ?? false,
            noiseSuppression: options.microphone?.noiseSuppression ?? false,
          },
        })
        mediaStreamRef.current = stream
        pendingInitialStreamRef.current = stream

        const trackSettings = stream.getAudioTracks()[0]?.getSettings()
        const sourceSampleRate = trackSettings.sampleRate || 48_000
        const audioContext = new AudioContext({ sampleRate: sourceSampleRate })
        audioContextRef.current = audioContext

        const vad = await MicVAD.new({
          audioContext,
          baseAssetPath: VAD_ASSET_BASE_PATH,
          getStream: async () => {
            if (pendingInitialStreamRef.current) {
              const initialStream = pendingInitialStreamRef.current
              pendingInitialStreamRef.current = null
              return initialStream
            }

            return navigator.mediaDevices.getUserMedia({
              audio: {
                autoGainControl: options.microphone?.autoGainControl ?? true,
                echoCancellation: options.microphone?.echoCancellation ?? false,
                noiseSuppression: options.microphone?.noiseSuppression ?? false,
              },
            })
          },
          minSpeechMs: LOCAL_VAD_MIN_SPEECH_MS,
          model: "v5",
          onSpeechEnd: () => {
            scheduleLocalGateClose()
          },
          onSpeechStart: () => {
            openLocalGate()
          },
          onVADMisfire: () => {
            scheduleLocalGateClose()
          },
          onnxWASMBasePath: ORT_WASM_BASE_PATH,
          preSpeechPadMs: LOCAL_VAD_PRE_SPEECH_PAD_MS,
          redemptionMs: LOCAL_VAD_REDEMPTION_MS,
          startOnLoad: false,
          submitUserSpeechOnPause: false,
        })
        vadRef.current = vad

        const source = audioContext.createMediaStreamSource(stream)
        mediaSourceRef.current = source

        const ws = new WebSocket(tokenPayload.wsUrl)
        ws.binaryType = "arraybuffer"
        wsRef.current = ws

        await new Promise<void>((resolve, reject) => {
          let settled = false

          const fail = (error: Error) => {
            if (settled) {
              return
            }
            settled = true
            reject(error)
          }

          ws.onopen = () => {
            activeRef.current = true
            pausedRef.current = false
            setStatus("connected")
            settled = true
            resolve()
          }

          ws.onmessage = (event) => {
            try {
              const payload = JSON.parse(String(event.data)) as {
                error?: string
                status?: string
                text?: string
                type?: "error" | "final" | "partial" | "status"
              }

              if (payload.type === "error") {
                setStatus("error")
                config.onError?.(
                  new Error(payload.error || "Qwen realtime returned an error.")
                )
                return
              }

              if (payload.type === "status") {
                if (payload.status === "paused") {
                  setStatus("paused")
                } else if (payload.status === "processing") {
                  setStatus("transcribing")
                } else if (
                  payload.status === "connected" ||
                  payload.status === "listening"
                ) {
                  setStatus("connected")
                } else if (payload.status === "disconnected") {
                  setStatus("disconnected")
                }
                return
              }

              if (payload.type === "partial") {
                const nextText = payload.text || ""
                lastPartialRef.current = nextText
                config.onPartialTranscript?.({ text: nextText })
                return
              }

              if (payload.type === "final") {
                lastPartialRef.current = ""
                config.onPartialTranscript?.({ text: "" })
                config.onFinalTranscript?.({
                  lowConfidence: false,
                  text: payload.text,
                })
              }
            } catch {
              // ignore malformed messages
            }
          }

          ws.onerror = (event) => {
            setStatus("error")
            if (!settled) {
              fail(new Error("Unable to open the Qwen realtime socket."))
              return
            }
            config.onError?.(event)
          }

          ws.onclose = () => {
            if (!settled) {
              fail(new Error("Qwen realtime socket closed before starting."))
              return
            }
            activeRef.current = false
            setStatus("disconnected")
          }
        })

        const queuePcmBuffer = (buffer: ArrayBuffer) => {
          if (!activeRef.current || pausedRef.current || ws.readyState !== WebSocket.OPEN) {
            return
          }

          if (!localGateOpenRef.current) {
            preRollAudioChunksRef.current.push(buffer)
            if (preRollAudioChunksRef.current.length > LOCAL_VAD_BUFFER_FRAME_LIMIT) {
              preRollAudioChunksRef.current.shift()
            }
            return
          }

          pendingAudioChunksRef.current.push(buffer)
          pendingAudioBytesRef.current += buffer.byteLength

          if (pendingAudioBytesRef.current >= TARGET_PCM_CHUNK_BYTES) {
            flushPendingAudio()
          }
        }

        if (
          typeof AudioWorkletNode !== "undefined" &&
          audioContext.audioWorklet &&
          typeof audioContext.audioWorklet.addModule === "function"
        ) {
          await audioContext.audioWorklet.addModule("/qwen-mic-worklet.js")

          const workletNode = new AudioWorkletNode(
            audioContext,
            "qwen-mic-capture",
            {
              numberOfInputs: 1,
              numberOfOutputs: 0,
              processorOptions: {
                targetSampleRate: TARGET_SAMPLE_RATE,
              },
            }
          )
          mediaWorkletNodeRef.current = workletNode
          workletNode.port.onmessage = (event) => {
            queuePcmBuffer(event.data as ArrayBuffer)
          }

          source.connect(workletNode)
        } else {
          const processor = audioContext.createScriptProcessor(4096, 1, 1)
          mediaProcessorRef.current = processor

          processor.onaudioprocess = (event) => {
            if (!activeRef.current || pausedRef.current || ws.readyState !== WebSocket.OPEN) {
              return
            }

            const inputData = event.inputBuffer.getChannelData(0)
            const resampled = resamplePcmFallback(inputData, sourceSampleRate)
            queuePcmBuffer(float32ToPcm16Buffer(resampled))
          }

          source.connect(processor)
          processor.connect(audioContext.destination)
        }

        await vad.start()
        flushTimerRef.current = setInterval(() => {
          flushPendingAudio()
        }, PCM_FLUSH_INTERVAL_MS)
      } catch (error) {
        teardown()
        setStatus("error")
        if (error instanceof Error || error instanceof Event) {
          config.onError?.(error)
        }
        throw error
      }
    },
    [config, flushPendingAudio, openLocalGate, scheduleLocalGateClose, teardown]
  )

  const pause = useCallback(async () => {
    const socket = wsRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return
    }

    pausedRef.current = true
    localGateOpenRef.current = false
    clearHangoverTimer()
    clearPendingAudio()
    clearPreRollAudio()
    await vadRef.current?.pause()
    socket.send(JSON.stringify({ action: "pause", type: "control" }))
    setStatus("paused")
  }, [clearHangoverTimer, clearPendingAudio, clearPreRollAudio])

  const resume = useCallback(async () => {
    const socket = wsRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return
    }

    pausedRef.current = false
    await vadRef.current?.start()
    socket.send(JSON.stringify({ action: "resume", type: "control" }))
    setStatus("connected")
  }, [])

  return {
    clearTranscripts,
    connect,
    disconnect,
    pause,
    resume,
    status,
  }
}
