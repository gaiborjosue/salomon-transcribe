"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Copy } from "lucide-react"

import { cn } from "@/lib/utils"
import { useDebounce } from '@/hooks/use-debounce'
import { usePrevious } from '@/hooks/use-previous'
import { useScribe } from '@/hooks/use-scribe'
import { Button } from "@/components/ui/button"
import { ShimmeringText } from "@/components/ui/shimmering-text"

import { getScribeToken } from "@/app/realtime-transcriber-01/actions/get-scribe-token"
import { LanguageSelector } from "@/app/realtime-transcriber-01/components/language-selector"

interface RecordingState {
  error: string
  latenciesMs: number[]
}

type ConnectionState = "idle" | "connecting" | "connected" | "disconnecting"

const TranscriptCharacter = React.memo(
  ({ char, delay }: { char: string; delay: number }) => {
    return (
      <motion.span
        initial={{ filter: `blur(3.5px)`, opacity: 0 }}
        animate={{ filter: `none`, opacity: 1 }}
        transition={{ duration: 0.5, delay }}
        style={{ willChange: delay > 0 ? "filter, opacity" : "auto" }}
      >
        {char}
      </motion.span>
    )
  }
)
TranscriptCharacter.displayName = "TranscriptCharacter"

// Memoize background effects to prevent re-renders
const BackgroundAura = React.memo(
  ({ status, isConnected }: { status: string; isConnected: boolean }) => {
    const isActive = status === "connecting" || isConnected

    return (
      <div
        className={cn(
          "pointer-events-none fixed inset-0 transition-opacity duration-300 ease-out",
          isActive ? "opacity-100" : "opacity-0"
        )}
      >
        {/* Center bottom pool - main glow */}
        <div
          className="absolute bottom-0 left-1/2 -translate-x-1/2"
          style={{
            width: "130%",
            height: "20vh",
            background:
              "radial-gradient(ellipse 100% 100% at 50% 100%, rgba(34, 211, 238, 0.5) 0%, rgba(168, 85, 247, 0.4) 35%, rgba(251, 146, 60, 0.5) 70%, transparent 100%)",
            filter: "blur(80px)",
          }}
        />

        {/* Pulsing layer */}
        <div
          className={cn(
            "absolute bottom-0 left-1/2 -translate-x-1/2 animate-pulse",
            isConnected ? "opacity-100" : "opacity-80"
          )}
          style={{
            width: "100%",
            height: "18vh",
            background:
              "radial-gradient(ellipse 100% 100% at 50% 100%, rgba(134, 239, 172, 0.5) 0%, rgba(192, 132, 252, 0.4) 50%, transparent 100%)",
            filter: "blur(60px)",
            animationDuration: "4s",
          }}
        />

        {/* Left corner bloom */}
        <div
          className="absolute bottom-0 left-0"
          style={{
            width: "25vw",
            height: "30vh",
            background:
              "radial-gradient(circle at 0% 100%, rgba(34, 211, 238, 0.5) 0%, rgba(134, 239, 172, 0.3) 30%, transparent 60%)",
            filter: "blur(70px)",
          }}
        />

        {/* Left rising glow - organic curve */}
        <div
          className="absolute bottom-0 -left-8"
          style={{
            width: "20vw",
            height: "45vh",
            background:
              "radial-gradient(ellipse 50% 100% at 10% 100%, rgba(34, 211, 238, 0.4) 0%, rgba(134, 239, 172, 0.25) 25%, transparent 60%)",
            filter: "blur(60px)",
            animation: "pulseGlow 5s ease-in-out infinite alternate",
          }}
        />

        {/* Right corner bloom */}
        <div
          className="absolute right-0 bottom-0"
          style={{
            width: "25vw",
            height: "30vh",
            background:
              "radial-gradient(circle at 100% 100%, rgba(251, 146, 60, 0.5) 0%, rgba(251, 146, 60, 0.3) 30%, transparent 60%)",
            filter: "blur(70px)",
          }}
        />

        {/* Right rising glow - organic curve */}
        <div
          className="absolute -right-8 bottom-0"
          style={{
            width: "20vw",
            height: "45vh",
            background:
              "radial-gradient(ellipse 50% 100% at 90% 100%, rgba(251, 146, 60, 0.4) 0%, rgba(192, 132, 252, 0.25) 25%, transparent 60%)",
            filter: "blur(60px)",
            animation: "pulseGlow 5s ease-in-out infinite alternate-reverse",
          }}
        />

        {/* Shimmer overlay */}
        <div
          className="absolute bottom-0 left-1/2 -translate-x-1/2"
          style={{
            width: "100%",
            height: "15vh",
            background:
              "linear-gradient(90deg, rgba(34, 211, 238, 0.3) 0%, rgba(168, 85, 247, 0.3) 30%, rgba(251, 146, 60, 0.3) 60%, rgba(134, 239, 172, 0.3) 100%)",
            filter: "blur(30px)",
            animation: "shimmer 8s linear infinite",
          }}
        />
      </div>
    )
  }
)
BackgroundAura.displayName = "BackgroundAura"

// Memoize bottom controls with comparison function
const BottomControls = React.memo(
  ({
    isConnected,
    hasError,
    isMac,
    onStop,
  }: {
    isConnected: boolean
    hasError: boolean
    isMac: boolean
    onStop: () => void
  }) => {
    return (
      <AnimatePresence mode="popLayout">
        {isConnected && !hasError && (
          <motion.div
            key="bottom-controls"
            initial={{ opacity: 0, y: 10 }}
            animate={{
              opacity: 1,
              y: 0,
              transition: { duration: 0.1 },
            }}
            exit={{
              opacity: 0,
              y: 10,
              transition: { duration: 0.1 },
            }}
            className="fixed bottom-8 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2"
          >
            <button
              onClick={onStop}
              className="bg-foreground text-background border-foreground/10 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium shadow-lg transition-opacity hover:opacity-90"
            >
              Stop
              <kbd className="border-background/20 bg-background/10 inline-flex h-5 items-center rounded border px-1.5 font-mono text-xs">
                {isMac ? "⌘K" : "Ctrl+K"}
              </kbd>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    )
  },
  (prev, next) => {
    if (prev.isConnected !== next.isConnected) return false
    if (prev.hasError !== next.hasError) return false
    if (prev.isMac !== next.isMac) return false
    return true
  }
)
BottomControls.displayName = "BottomControls"

export default function RealtimeTranscriberPage() {
  const [recording, setRecording] = useState<RecordingState>({
    error: "",
    latenciesMs: [],
  })
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null)
  const [connectionState, setConnectionStateState] =
    useState<ConnectionState>("idle")
  const [finalEnglishTranscript, setFinalEnglishTranscript] = useState("")
  const [previewEnglishTranscript, setPreviewEnglishTranscript] = useState("")
  const [partialSpanishTranscript, setPartialSpanishTranscript] = useState("")

  const [isMac, setIsMac] = useState(true)
  useEffect(() => {
    setIsMac(/(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent))
  }, [])

  const segmentStartMsRef = useRef<number | null>(null)
  const lastTranscriptRef = useRef<string>("")
  const finalTranscriptsRef = useRef<string[]>([])

  const startSoundRef = useRef<HTMLAudioElement | null>(null)
  const endSoundRef = useRef<HTMLAudioElement | null>(null)
  const errorSoundRef = useRef<HTMLAudioElement | null>(null)

  const errorTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const lastOperationTimeRef = useRef(0)
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const connectionStateRef = useRef<ConnectionState>("idle")
  const previewAbortRef = useRef<AbortController | null>(null)
  const previewRequestIdRef = useRef(0)
  const sessionVersionRef = useRef(0)
  const finalEnglishSegmentsRef = useRef<string[]>([])
  const finalTranslationChainRef = useRef<Promise<void>>(Promise.resolve())

  const updateConnectionState = useCallback(
    (next: ConnectionState) => {
      connectionStateRef.current = next
      setConnectionStateState(next)
    },
    [setConnectionStateState]
  )

  const clearPreviewTranslation = useCallback(() => {
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    previewRequestIdRef.current += 1
  }, [])

  const requestTranslation = useCallback(
    async ({
      text,
      context,
      signal,
    }: {
      text: string
      context?: string
      signal?: AbortSignal
    }) => {
      const response = await fetch("/api/home-translate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text, context }),
        signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || "Translation failed.")
      }

      const payload = (await response.json()) as { text?: unknown }

      return typeof payload.text === "string" ? payload.text.trim() : ""
    },
    []
  )

  const clearSessionRefs = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
    }
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current)
      errorTimeoutRef.current = null
    }

    segmentStartMsRef.current = null
    lastTranscriptRef.current = ""
    finalTranscriptsRef.current = []
    finalEnglishSegmentsRef.current = []
    finalTranslationChainRef.current = Promise.resolve()
    sessionVersionRef.current += 1
    clearPreviewTranslation()
  }, [clearPreviewTranslation])

  // === Callbacks for Scribe ===
  const onPartialTranscript = useCallback((data: { text?: string }) => {
    console.log("[v0] onPartialTranscript called:", data)
    // Only process if we're connected
    if (connectionStateRef.current !== "connected") {
      console.log("[v0] Not connected, ignoring partial transcript")
      return
    }

    const currentText = data.text || ""
    console.log("[v0] Partial transcript:", currentText)

    if (currentText === lastTranscriptRef.current) {
      console.log("[v0] Same as last transcript, skipping")
      return
    }

    lastTranscriptRef.current = currentText
    setPartialSpanishTranscript(currentText)

    if (currentText.length > 0 && segmentStartMsRef.current != null) {
      const latency = performance.now() - segmentStartMsRef.current
      setRecording((prev) => ({
        ...prev,
        latenciesMs: [...prev.latenciesMs.slice(-29), latency],
      }))
      segmentStartMsRef.current = null
    }
  }, [])

  const onFinalTranscript = useCallback((data: { text?: string }) => {
    console.log("[v0] onFinalTranscript called:", data)
    // Only process if we're connected
    if (connectionStateRef.current !== "connected") {
      console.log("[v0] Not connected, ignoring final transcript")
      return
    }

    lastTranscriptRef.current = ""
    setPartialSpanishTranscript("")

    if (data.text && data.text.length > 0) {
      console.log("[v0] Final transcript received:", data.text)
      // Add to final transcripts
      finalTranscriptsRef.current = [...finalTranscriptsRef.current, data.text]
      clearPreviewTranslation()
      setPreviewEnglishTranscript("")

      const sessionVersion = sessionVersionRef.current
      const context = finalTranscriptsRef.current.slice(-3, -1).join(" ")
      const spanishSegment = data.text

      finalTranslationChainRef.current = finalTranslationChainRef.current
        .catch(() => undefined)
        .then(async () => {
          let englishSegment = spanishSegment

          try {
            const translated = await requestTranslation({
              text: spanishSegment,
              context,
            })
            if (translated) {
              englishSegment = translated
            }
          } catch (error) {
            console.error("[Groq Translate] Final segment error:", error)
          }

          if (
            sessionVersionRef.current !== sessionVersion ||
            connectionStateRef.current !== "connected"
          ) {
            return
          }

          finalEnglishSegmentsRef.current = [
            ...finalEnglishSegmentsRef.current,
            englishSegment,
          ]
          setFinalEnglishTranscript(finalEnglishSegmentsRef.current.join(" "))
        })

      if (segmentStartMsRef.current != null) {
        const latency = performance.now() - segmentStartMsRef.current
        setRecording((prev) => ({
          ...prev,
          latenciesMs: [...prev.latenciesMs.slice(-29), latency],
        }))
      }
    }
    segmentStartMsRef.current = null
  }, [])

  const onError = useCallback((error: Error | Event) => {
    console.error("[Scribe] Error:", error)

    // Ignore errors if we're not supposed to be connected
    if (connectionStateRef.current !== "connected") {
      console.log("[Scribe] Ignoring error - not connected")
      return
    }

    const errorMessage =
      error instanceof Error ? error.message : "Transcription error"

    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current)
    }

    errorTimeoutRef.current = setTimeout(() => {
      if (connectionStateRef.current !== "connected") return

      setRecording((prev) => ({
        ...prev,
        error: errorMessage,
      }))
      errorSoundRef.current?.play().catch(() => {})
    }, 500)
  }, [])

  const scribeConfig = useMemo(
    () => ({
      modelId: "scribe_v2_realtime" as const,
      onPartialTranscript,
      onFinalTranscript,
      onError,
    }),
    [onPartialTranscript, onFinalTranscript, onError]
  )

  const scribe = useScribe(scribeConfig)

  useEffect(() => {
    if (connectionState === "connecting" && scribe.status === "error") {
      updateConnectionState("idle")
      setRecording((prev) => ({
        ...prev,
        error: prev.error || "Failed to connect to realtime transcription.",
      }))
      return
    }

    if (
      connectionState === "connected" &&
      (scribe.status === "disconnected" || scribe.status === "error")
    ) {
      updateConnectionState("idle")
    }
  }, [connectionState, scribe.status, updateConnectionState])

  // Clear transcript when not connected
  useEffect(() => {
    if (connectionState !== "connected") {
      clearPreviewTranslation()
      setFinalEnglishTranscript("")
      setPreviewEnglishTranscript("")
      setPartialSpanishTranscript("")
    }
  }, [clearPreviewTranslation, connectionState])

  useEffect(() => {
    if (connectionState !== "connected") return

    const partialTranscript = partialSpanishTranscript.trim()

    if (!partialTranscript) {
      clearPreviewTranslation()
      setPreviewEnglishTranscript("")
      return
    }

    const controller = new AbortController()
    const requestId = previewRequestIdRef.current + 1
    previewRequestIdRef.current = requestId

    previewAbortRef.current?.abort()
    previewAbortRef.current = controller
    const context = finalTranscriptsRef.current.slice(-2).join(" ")

    const timeoutId = window.setTimeout(async () => {
      try {
        const nextText = await requestTranslation({
          text: partialTranscript,
          context,
          signal: controller.signal,
        })

        if (
          !controller.signal.aborted &&
          previewRequestIdRef.current === requestId
        ) {
          setPreviewEnglishTranscript(nextText || partialTranscript)
        }
      } catch (error) {
        if (controller.signal.aborted) return

        console.error("[Groq Translate] Preview error:", error)

        if (previewRequestIdRef.current === requestId) {
          setPreviewEnglishTranscript(partialTranscript)
        }
      }
    }, 700)

    return () => {
      window.clearTimeout(timeoutId)
      controller.abort()
    }
  }, [
    clearPreviewTranslation,
    connectionState,
    partialSpanishTranscript,
    requestTranslation,
  ])

  // Simulate audio chunk timing for latency measurement
  useEffect(() => {
    // Clear any existing interval
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
    }

    if (connectionState !== "connected") return

    timerIntervalRef.current = setInterval(() => {
      if (segmentStartMsRef.current === null) {
        segmentStartMsRef.current = performance.now()
      }
    }, 100)

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current)
        timerIntervalRef.current = null
      }
    }
  }, [connectionState])

  const handleToggleRecording = useCallback(async () => {
    const now = Date.now()
    const timeSinceLastOp = now - lastOperationTimeRef.current

    // DISCONNECT
    if (connectionState === "connected" || connectionState === "connecting") {
      console.log("[Scribe] Disconnecting...")

      // 1. Update UI state immediately
      updateConnectionState("idle")
      setFinalEnglishTranscript("")
      setPreviewEnglishTranscript("")
      setPartialSpanishTranscript("")
      setRecording({ error: "", latenciesMs: [] })
      clearSessionRefs()

      // 2. Disconnect (async, don't wait)
      try {
        scribe.disconnect()
        scribe.clearTranscripts()
      } catch {
        // Ignore errors
      }

      // 3. Play sound
      if (endSoundRef.current) {
        endSoundRef.current.currentTime = 0
        endSoundRef.current.play().catch(() => {})
      }

      lastOperationTimeRef.current = now
      return
    }

    // Debounce rapid clicks for CONNECT
    if (timeSinceLastOp < 200) {
      console.log("[Scribe] Ignoring rapid click")
      return
    }
    lastOperationTimeRef.current = now

    // CONNECT
    if (connectionState !== "idle") {
      console.log("[Scribe] Not in idle state, ignoring")
      return
    }

    console.log("[Scribe] Connecting...")
    updateConnectionState("connecting")
    setFinalEnglishTranscript("")
    setPreviewEnglishTranscript("")
    setPartialSpanishTranscript("")
    setRecording({ error: "", latenciesMs: [] })
    clearSessionRefs()

    try {
      const result = await getScribeToken()

      // Check if user cancelled using ref (gets current value)
      if (connectionStateRef.current === "idle") {
        console.log("[Scribe] Cancelled during token fetch")
        return
      }

      if (result.error || !result.token) {
        throw new Error(result.error || "Failed to get token")
      }

      await scribe.connect({
        token: result.token,
        languageCode: selectedLanguage || undefined,
        microphone: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
      })

      // Check again after connect completes
      if (connectionStateRef.current !== "connecting") {
        console.log("[Scribe] Cancelled after connection")
        try {
          scribe.disconnect()
        } catch {
          // Ignore
        }
        return
      }

      console.log("[Scribe] Connected")
      updateConnectionState("connected")

      // Play start sound
      if (startSoundRef.current) {
        startSoundRef.current.currentTime = 0
        startSoundRef.current.play().catch(() => {})
      }
    } catch (error) {
      console.error("[Scribe] Connection error:", error)
      updateConnectionState("idle")
      setRecording((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : "Connection failed",
      }))
    }
  }, [
    clearSessionRefs,
    connectionState,
    scribe,
    selectedLanguage,
    updateConnectionState,
  ])

  // Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "k" &&
        (e.metaKey || e.ctrlKey) &&
        e.target instanceof HTMLElement &&
        !["INPUT", "TEXTAREA"].includes(e.target.tagName)
      ) {
        e.preventDefault()
        handleToggleRecording()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [handleToggleRecording])

  // Note: No unmount cleanup - React Strict Mode causes issues
  // The browser will handle websocket cleanup on page unload

  // Preload audio files on mount (no auto-play)
  useEffect(() => {
    const sounds = [
      {
        ref: startSoundRef,
        url: "https://ui.elevenlabs.io/sounds/transcriber-start.mp3",
      },
      {
        ref: endSoundRef,
        url: "https://ui.elevenlabs.io/sounds/transcriber-end.mp3",
      },
      {
        ref: errorSoundRef,
        url: "https://ui.elevenlabs.io/sounds/transcriber-error.mp3",
      },
    ]

    sounds.forEach(({ ref, url }) => {
      const audio = new Audio(url)
      audio.volume = 0.6
      audio.preload = "auto"
      audio.load()
      ref.current = audio
    })
  }, [])

  const committedText = recording.error ? recording.error : finalEnglishTranscript
  const previewText = recording.error ? "" : previewEnglishTranscript
  const combinedTranscript = [committedText, previewText].filter(Boolean).join(" ")
  const hasContent =
    Boolean(recording.error || committedText || previewText) &&
    connectionState === "connected"

  return (
    <div className="dark text-foreground relative min-h-screen w-full overflow-hidden bg-[#1f1f1f]">
      <div className="absolute inset-0 bg-[#1f1f1f]" />
      <div className="absolute inset-0 opacity-[0.06] [background-image:linear-gradient(rgba(255,255,255,0.14)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.14)_1px,transparent_1px)] [background-size:72px_72px]" />

      <div className="relative mx-auto flex h-full w-full max-w-4xl flex-col items-center justify-center">
      <BackgroundAura
        status={connectionState === "connecting" ? "connecting" : scribe.status}
        isConnected={connectionState === "connected"}
      />

      <style jsx>{`
        @keyframes shimmer {
          0% {
            transform: translateX(-20%) scale(1);
          }
          50% {
            transform: translateX(20%) scale(1.1);
          }
          100% {
            transform: translateX(-20%) scale(1);
          }
        }
        @keyframes drift {
          0% {
            transform: translateX(-10%) scale(1);
          }
          100% {
            transform: translateX(10%) scale(1.05);
          }
        }
        @keyframes pulseGlow {
          0% {
            opacity: 0.5;
            transform: translateY(0) scale(1);
          }
          100% {
            opacity: 0.8;
            transform: translateY(-5%) scale(1.02);
          }
        }
      `}</style>

      <div className="relative flex h-full w-full flex-col items-center justify-center gap-8 overflow-hidden px-8 py-12">
        {/* Main transcript area */}
        <div className="relative flex min-h-[350px] w-full flex-1 items-center justify-center overflow-hidden">
          {/* Transcript - shown when there's content */}
          <div
            className={cn(
              "absolute inset-0 transition-opacity duration-250",
              hasContent ? "opacity-100" : "pointer-events-none opacity-0"
            )}
          >
            {hasContent && (
              <TranscriberTranscript
                transcript={combinedTranscript}
                committedTranscript={committedText}
                previewTranscript={previewText}
                error={recording.error}
                isConnected={connectionState === "connected"}
              />
            )}
          </div>

          {/* Status text - shown when no content */}
          <div
            className={cn(
              "absolute inset-0 flex items-center justify-center transition-opacity duration-250",
              !hasContent ? "opacity-100" : "pointer-events-none opacity-0"
            )}
          >
            <div
              className={cn(
                "absolute transition-opacity duration-250",
                connectionState === "connecting"
                  ? "opacity-100"
                  : "pointer-events-none opacity-0"
              )}
            >
              <ShimmeringText
                text="Connecting..."
                className="text-2xl font-light tracking-wide whitespace-nowrap"
              />
            </div>
            <div
              className={cn(
                "absolute transition-opacity duration-250",
                connectionState === "connected" && !hasContent
                  ? "opacity-100"
                  : "pointer-events-none opacity-0"
              )}
            >
              <ShimmeringText
                text="Say something aloud..."
                className="text-3xl font-light tracking-wide whitespace-nowrap"
              />
            </div>
          </div>

          {/* Language selector and button - only shown when not connected */}
          <div
            className={cn(
              "absolute inset-0 flex items-center justify-center transition-opacity duration-250",
              connectionState === "idle"
                ? "opacity-100"
                : "pointer-events-none opacity-0"
            )}
          >
            <div className="flex w-full max-w-sm flex-col gap-4 px-8">
              <div className="flex flex-col items-center gap-6">
                <div className="flex flex-col items-center gap-2 text-center">
                  <h1 className="text-2xl font-semibold tracking-tight">
                    Realtime Speech to Text
                  </h1>
                  <p className="text-muted-foreground text-sm">
                    Transcribe your voice in real-time with high accuracy
                  </p>
                </div>

                <div className="w-full space-y-2">
                  <label className="text-foreground/70 text-sm font-medium">
                    Language
                  </label>
                  <LanguageSelector
                    value={selectedLanguage}
                    onValueChange={setSelectedLanguage}
                    disabled={connectionState !== "idle"}
                  />
                </div>

                <Button
                  onClick={handleToggleRecording}
                  disabled={false}
                  size="lg"
                  className="bg-foreground/95 hover:bg-foreground/90 w-full justify-center gap-3"
                >
                  <span>Start Transcribing</span>
                  <kbd className="border-background/20 bg-background/10 hidden h-5 items-center gap-1 rounded border px-1.5 font-mono text-xs sm:inline-flex">
                    {isMac ? "⌘K" : "Ctrl+K"}
                  </kbd>
                </Button>

              </div>
            </div>
          </div>
        </div>

        <BottomControls
          isConnected={connectionState === "connected"}
          hasError={Boolean(recording.error)}
          isMac={isMac}
          onStop={handleToggleRecording}
        />
      </div>
    </div>
    </div>
  )
}

const TranscriberTranscript = React.memo(
  ({
    transcript,
    committedTranscript,
    previewTranscript,
    error,
    isConnected,
  }: {
    transcript: string
    committedTranscript: string
    previewTranscript?: string
    error: string
    isConnected: boolean
  }) => {
    const committedCharacters = useMemo(
      () => committedTranscript.split(""),
      [committedTranscript]
    )
    const previewCharacters = useMemo(
      () => (previewTranscript || "").split(""),
      [previewTranscript]
    )
    const previousCommittedChars = useDebounce(
      usePrevious(committedCharacters.length) || 0,
      100
    )
    const previousPreviewChars = useDebounce(
      usePrevious(previewCharacters.length) || 0,
      100
    )
    const scrollRef = useRef<HTMLDivElement>(null)
    const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const shouldAutoScrollRef = useRef(true)

    const handleScroll = useCallback(() => {
      const container = scrollRef.current
      if (!container) return

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight

      shouldAutoScrollRef.current = distanceFromBottom < 48
    }, [])

    // Auto-scroll to bottom when connected and text is updating,
    // unless the user has manually scrolled upward.
    useEffect(() => {
      if (isConnected && scrollRef.current && shouldAutoScrollRef.current) {
        if (scrollTimeoutRef.current) {
          clearTimeout(scrollTimeoutRef.current)
        }
        scrollTimeoutRef.current = setTimeout(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
          }
        }, 50)
      }
      return () => {
        if (scrollTimeoutRef.current) {
          clearTimeout(scrollTimeoutRef.current)
        }
      }
    }, [transcript, isConnected])

    return (
      <div className="absolute inset-0 flex flex-col">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="minimal-scrollbar flex-1 overflow-y-auto"
        >
          <div className="flex min-h-full w-full items-end px-12 py-8 pb-28">
            <div className="w-full">
              {committedCharacters.length > 0 && (
                <div
                  className={cn(
                    "text-foreground/90 w-full text-xl leading-relaxed font-light",
                    error && "text-red-500"
                  )}
                >
                  {committedCharacters.map((char, index) => {
                    const delay =
                      index >= previousCommittedChars
                        ? (index - previousCommittedChars + 1) * 0.012
                        : 0
                    return (
                      <TranscriptCharacter
                        key={`committed-${index}`}
                        char={char}
                        delay={delay}
                      />
                    )
                  })}
                </div>
              )}
              {!error && previewCharacters.length > 0 && (
                <div className="text-foreground/55 mt-2 w-full text-xl leading-relaxed font-light">
                  {previewCharacters.map((char, index) => {
                    const delay =
                      index >= previousPreviewChars
                        ? (index - previousPreviewChars + 1) * 0.012
                        : 0
                    return (
                      <TranscriptCharacter
                        key={`preview-${index}`}
                        char={char}
                        delay={delay}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
        <style jsx>{`
          .minimal-scrollbar {
            scrollbar-width: thin;
            scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
          }
          .minimal-scrollbar::-webkit-scrollbar {
            width: 8px;
          }
          .minimal-scrollbar::-webkit-scrollbar-track {
            background: transparent;
          }
          .minimal-scrollbar::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.18);
            border-radius: 999px;
          }
          .minimal-scrollbar::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.28);
          }
        `}</style>
        {transcript && !error && !previewTranscript && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-4 right-4 h-8 w-8 opacity-0 transition-opacity hover:opacity-60"
            onClick={() => {
              navigator.clipboard.writeText(transcript)
            }}
            aria-label="Copy transcript"
          >
            <Copy className="h-4 w-4" />
          </Button>
        )}
      </div>
    )
  }
)
TranscriberTranscript.displayName = "TranscriberTranscript"
