"use client"

import { useCallback, useRef, useState } from "react"

/** Scribe connection status */
type ScribeStatus = "idle" | "connecting" | "connected" | "disconnected" | "error"

interface ScribeConfig {
  modelId: "scribe_v2_realtime"
  onPartialTranscript?: (data: { text?: string }) => void
  onFinalTranscript?: (data: { text?: string }) => void
  onError?: (error: Error | Event) => void
}

interface ConnectOptions {
  token: string
  languageCode?: string
  microphone?: {
    echoCancellation?: boolean
    noiseSuppression?: boolean
    autoGainControl?: boolean
  }
}

interface ScribeHook {
  status: ScribeStatus
  connect: (options: ConnectOptions) => Promise<void>
  disconnect: () => void
  clearTranscripts: () => void
}

function pcm16ToBase64(pcmData: Int16Array): string {
  const bytes = new Uint8Array(pcmData.buffer)
  let binary = ""

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }

  return btoa(binary)
}

export function useScribe(config: ScribeConfig): ScribeHook {
  const [status, setStatus] = useState<ScribeStatus>("idle")
  const wsRef = useRef<WebSocket | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)

  const disconnect = useCallback(() => {
    // Close WebSocket
    if (wsRef.current) {
      try {
        wsRef.current.close()
      } catch {
        // Ignore
      }
      wsRef.current = null
    }

    // Stop media stream tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }

    // Close audio context
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close()
      } catch {
        // Ignore
      }
      audioContextRef.current = null
    }

    // Disconnect processor
    if (processorRef.current) {
      try {
        processorRef.current.disconnect()
      } catch {
        // Ignore
      }
      processorRef.current = null
    }

    setStatus("disconnected")
  }, [])

  const clearTranscripts = useCallback(() => {
    // This is a no-op in this implementation since transcripts are managed externally
  }, [])

  const connect = useCallback(
    async (options: ConnectOptions) => {
      setStatus("connecting")

      try {
        // Get microphone access - use native sample rate, we'll resample later
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: options.microphone?.echoCancellation ?? false,
            noiseSuppression: options.microphone?.noiseSuppression ?? false,
            autoGainControl: options.microphone?.autoGainControl ?? true,
          },
        })
        mediaStreamRef.current = stream

        // Get the actual sample rate from the audio track
        const audioTrack = stream.getAudioTracks()[0]
        const trackSettings = audioTrack.getSettings()
        const streamSampleRate = trackSettings.sampleRate || 48000
        
        // Create audio context matching the stream's sample rate
        const audioContext = new AudioContext({ sampleRate: streamSampleRate })
        audioContextRef.current = audioContext
        
        const nativeSampleRate = streamSampleRate
        const targetSampleRate = 16000

        // Connect WebSocket - token is passed as query parameter for authentication
        const wsUrl = new URL("wss://api.elevenlabs.io/v1/speech-to-text/realtime")
        wsUrl.searchParams.set("model_id", config.modelId)
        wsUrl.searchParams.set("token", options.token)
        wsUrl.searchParams.set("audio_format", "pcm_16000")
        wsUrl.searchParams.set("commit_strategy", "vad")
        if (options.languageCode) {
          wsUrl.searchParams.set("language_code", options.languageCode)
        }

        const ws = new WebSocket(wsUrl.toString())
        wsRef.current = ws

        console.log("[v0] Connecting to WebSocket:", wsUrl.toString().replace(options.token, "TOKEN_HIDDEN"))
        
        await new Promise<void>((resolve, reject) => {
          let hasConnected = false
          
          ws.onopen = () => {
            console.log("[v0] WebSocket opened successfully")
            hasConnected = true
          }

          ws.onerror = (event) => {
            console.log("[v0] WebSocket error event")
            if (!hasConnected) {
              reject(new Error("WebSocket connection failed. Please verify your ElevenLabs API key is valid."))
            }
          }

          ws.onclose = (event) => {
            console.log("[v0] WebSocket closed:", event.code, event.reason)
            if (!hasConnected) {
              reject(new Error(`Connection closed: ${event.code} ${event.reason || "Unknown reason"}`))
            } else {
              setStatus("disconnected")
            }
          }

          ws.onmessage = (event) => {
            try {
              const data = JSON.parse(event.data)
              console.log("[v0] Received WebSocket message:", data.message_type, JSON.stringify(data).substring(0, 100))

              if (data.message_type === "session_started") {
                console.log("[v0] Session started:", data.session_id)
                setStatus("connected")
                resolve()
              } else if (data.message_type === "partial_transcript") {
                console.log("[v0] Calling onPartialTranscript with:", data.text)
                config.onPartialTranscript?.({ text: data.text })
              } else if (data.message_type === "committed_transcript" || data.message_type === "committed_transcript_with_timestamps") {
                console.log("[v0] Calling onFinalTranscript with:", data.text)
                config.onFinalTranscript?.({ text: data.text })
              } else if (data.message_type === "error" || data.message_type === "auth_error" || data.message_type === "quota_exceeded") {
                const errorMsg = data.error || data.message || "Scribe error"
                console.log("[v0] Scribe error:", errorMsg)
                setStatus("error")
                config.onError?.(new Error(errorMsg))
                if (!hasConnected) {
                  reject(new Error(errorMsg))
                }
              } else {
                console.log("[v0] Unhandled message type:", data.message_type, data)
              }
            } catch (e) {
              console.log("[v0] Failed to parse WebSocket message:", e, event.data)
            }
          }
        })

        // Set up audio processing
        const source = audioContext.createMediaStreamSource(stream)
        const processor = audioContext.createScriptProcessor(4096, 1, 1)
        processorRef.current = processor

        // Resampling function: convert from native sample rate to 16kHz
        const resample = (inputData: Float32Array): Float32Array => {
          if (nativeSampleRate === targetSampleRate) {
            return inputData
          }
          const ratio = nativeSampleRate / targetSampleRate
          const outputLength = Math.floor(inputData.length / ratio)
          const output = new Float32Array(outputLength)
          for (let i = 0; i < outputLength; i++) {
            const srcIndex = i * ratio
            const srcIndexFloor = Math.floor(srcIndex)
            const srcIndexCeil = Math.min(srcIndexFloor + 1, inputData.length - 1)
            const t = srcIndex - srcIndexFloor
            // Linear interpolation
            output[i] = inputData[srcIndexFloor] * (1 - t) + inputData[srcIndexCeil] * t
          }
          return output
        }

        let audioChunkCount = 0
        processor.onaudioprocess = (event) => {
          if (ws.readyState === WebSocket.OPEN) {
            const inputData = event.inputBuffer.getChannelData(0)
            // Check if there's actual audio data
            const maxSample = Math.max(...Array.from(inputData))
            if (audioChunkCount === 0 || audioChunkCount % 10 === 0) {
              console.log("[v0] Audio chunk:", audioChunkCount, "max sample:", maxSample.toFixed(4))
            }
            audioChunkCount++
            
            // Resample to 16kHz
            const resampledData = resample(inputData)
            // Convert to 16-bit PCM
            const pcmData = new Int16Array(resampledData.length)
            for (let i = 0; i < resampledData.length; i++) {
              const s = Math.max(-1, Math.min(1, resampledData[i]))
              pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff
            }

            ws.send(
              JSON.stringify({
                message_type: "input_audio_chunk",
                audio_base_64: pcm16ToBase64(pcmData),
                commit: false,
                sample_rate: targetSampleRate,
              })
            )
          } else {
            console.log("[v0] WebSocket not ready, state:", ws.readyState)
          }
        }

        source.connect(processor)
        processor.connect(audioContext.destination)
      } catch (error) {
        disconnect()
        setStatus("error")
        if (error instanceof Error || error instanceof Event) {
          config.onError?.(error)
        }
        throw error
      }
    },
    [config, disconnect]
  )

  return {
    status,
    connect,
    disconnect,
    clearTranscripts,
  }
}
