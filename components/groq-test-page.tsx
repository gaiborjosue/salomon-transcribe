"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Copy } from "lucide-react"

import { getBibleReferenceFragments } from "@/lib/bible-reference-highlighter"
import { cn } from "@/lib/utils"
import { useDebounce } from '@/hooks/use-debounce'
import { useGroqRealtimeTranslation } from "@/hooks/use-groq-realtime-translation"
import { usePrevious } from '@/hooks/use-previous'
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ShimmeringText } from "@/components/ui/shimmering-text"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import { LanguageSelector } from "@/app/realtime-transcriber-01/components/language-selector"

interface RecordingState {
  error: string
  latenciesMs: number[]
}

interface TranscriptEntry {
  id: string
  text: string
  timestampMs: number
}

type TranscriptionMode = "conversation" | "sermon"

type ConnectionState = "idle" | "connecting" | "connected" | "disconnecting"

interface BibleVerseLookup {
  chapter: number
  bookName: string
  reference: string
  translationId: string
  translationName: string
  verses: Array<{
    chapter: number
    text: string
    verse: number
  }>
}

interface BibleVerseLookupState {
  data?: BibleVerseLookup
  error?: string
  loading: boolean
}

const CHAPTER_VERSES_PER_PAGE = 5

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

async function fetchBibleVerse(query: string): Promise<BibleVerseLookup> {
  const response = await fetch(
    `https://bible-api.com/${encodeURIComponent(query)}?translation=kjv`
  )

  if (!response.ok) {
    throw new Error(`Bible lookup failed with status ${response.status}`)
  }

  const payload = (await response.json()) as {
    verses?: Array<{
      chapter?: number
      text?: string
      verse?: number
      book_name?: string
    }>
    reference?: string
    translation_id?: string
    translation_name?: string
  }

  const verses = Array.isArray(payload.verses)
    ? payload.verses
        .map((verse) => ({
          chapter:
            typeof verse.chapter === "number" ? verse.chapter : 0,
          text:
            typeof verse.text === "string"
              ? verse.text.replace(/\s+/g, " ").trim()
              : "",
          verse: typeof verse.verse === "number" ? verse.verse : 0,
        }))
        .filter((verse) => verse.chapter > 0 && verse.verse > 0 && verse.text)
    : []

  return {
    bookName:
      typeof payload.verses?.[0]?.book_name === "string"
        ? payload.verses[0].book_name
        : query,
    chapter: verses[0]?.chapter ?? 0,
    reference: typeof payload.reference === "string" ? payload.reference : query,
    translationId:
      typeof payload.translation_id === "string" ? payload.translation_id : "kjv",
    translationName:
      typeof payload.translation_name === "string"
        ? payload.translation_name
        : "King James Version",
    verses,
  }
}

function formatElapsedTime(timestampMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timestampMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function createPreviewEntries(text: string): TranscriptEntry[] {
  const blocks = text
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean)

  return blocks.map((block, index) => ({
    id: `preview-${index}`,
    text: block,
    timestampMs: index * 18000,
  }))
}

function looksLikeContinuation(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false

  if (trimmed.length <= 18) return true
  if (/^(and|or|but|so|because|that|when|where|which|who|then|to)\b/i.test(trimmed)) {
    return true
  }
  if (/^(verse|verses|chapter)\b/i.test(trimmed)) {
    return true
  }
  if (/^\d+[.:,-]?$/.test(trimmed)) {
    return true
  }
  if (/^(to|through)\s+\d+/i.test(trimmed)) {
    return true
  }
  if (/^[a-z(]/.test(trimmed)) {
    return true
  }

  return false
}

function endsLikeContinuation(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false

  if (/[,;:–—-]$/.test(trimmed)) return true
  if (/\b(of|to|and|or|that|when|where|with|through|from|was|were|is|are)$/i.test(trimmed)) {
    return true
  }

  return false
}

function mergeTranscriptEntry(
  previous: TranscriptEntry,
  nextText: string
): TranscriptEntry {
  const left = previous.text.trim()
  const right = nextText.trim()
  const joiner =
    left.endsWith("-") || /^[,.;:!?)]/.test(right) ? "" : " "

  return {
    ...previous,
    text: `${left}${joiner}${right}`.replace(/\s+/g, " ").trim(),
  }
}

function shouldMergeIntoPrevious(
  previous: TranscriptEntry | undefined,
  nextText: string,
  mode: TranscriptionMode
): boolean {
  if (!previous) return false

  const trimmed = nextText.trim()
  if (!trimmed) return false

  if (mode === "sermon") {
    return looksLikeContinuation(trimmed) || endsLikeContinuation(previous.text)
  }

  return (
    (trimmed.length <= 10 && looksLikeContinuation(trimmed)) ||
    (endsLikeContinuation(previous.text) && trimmed.length <= 24)
  )
}

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
    isPaused,
    hasError,
    isMac,
    onPauseToggle,
    onStop,
  }: {
    isConnected: boolean
    isPaused: boolean
    hasError: boolean
    isMac: boolean
    onPauseToggle: () => void
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
            className="fixed inset-x-4 bottom-6 z-50 flex items-center justify-center sm:inset-x-auto sm:bottom-8 sm:left-1/2 sm:-translate-x-1/2"
          >
            <div className="bg-background/55 border-border/60 flex w-full max-w-sm items-center gap-2 rounded-2xl border p-2 shadow-lg backdrop-blur-md sm:w-auto">
              <button
                onClick={onPauseToggle}
                className="bg-background/80 text-foreground border-border/50 inline-flex min-h-12 flex-1 items-center justify-center rounded-xl border px-4 py-3 text-sm font-medium transition-colors hover:bg-background"
              >
                {isPaused ? "Continue" : "Pause"}
              </button>
              <button
                onClick={onStop}
                className="bg-foreground text-background border-foreground/10 inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium transition-opacity hover:opacity-90"
              >
                <span>Stop</span>
                <kbd className="border-background/20 bg-background/10 hidden h-5 items-center rounded border px-1.5 font-mono text-xs sm:inline-flex">
                  {isMac ? "⌘K" : "Ctrl+K"}
                </kbd>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    )
  },
  (prev, next) => {
    if (prev.isConnected !== next.isConnected) return false
    if (prev.isPaused !== next.isPaused) return false
    if (prev.hasError !== next.hasError) return false
    if (prev.isMac !== next.isMac) return false
    return true
  }
)
BottomControls.displayName = "BottomControls"

interface GroqTestPageProps {
  initialTranscript?: string
  previewOnly?: boolean
}

export default function GroqTestPage({
  initialTranscript = "",
  previewOnly = false,
}: GroqTestPageProps) {
  const [recording, setRecording] = useState<RecordingState>({
    error: "",
    latenciesMs: [],
  })
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null)
  const [connectionState, setConnectionStateState] =
    useState<ConnectionState>(previewOnly ? "connected" : "idle")
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>(
    previewOnly ? createPreviewEntries(initialTranscript) : []
  )
  const [partialTranscript, setPartialTranscript] = useState("")
  const [isPaused, setIsPaused] = useState(false)
  const [transcriptionMode, setTranscriptionMode] =
    useState<TranscriptionMode>("conversation")

  const [isMac, setIsMac] = useState(true)
  useEffect(() => {
    setIsMac(/(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent))
  }, [])

  useEffect(() => {
    if (!previewOnly) return

    setConnectionStateState("connected")
    setTranscriptEntries(createPreviewEntries(initialTranscript))
    setPartialTranscript("")
    setIsPaused(false)
    setTranscriptionMode("conversation")
  }, [initialTranscript, previewOnly])

  const segmentStartMsRef = useRef<number | null>(null)
  const lastTranscriptRef = useRef<string>("")

  const startSoundRef = useRef<HTMLAudioElement | null>(null)
  const endSoundRef = useRef<HTMLAudioElement | null>(null)
  const errorSoundRef = useRef<HTMLAudioElement | null>(null)

  const errorTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const lastOperationTimeRef = useRef(0)
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const connectionStateRef = useRef<ConnectionState>("idle")
  const sessionStartedAtRef = useRef<number | null>(previewOnly ? 0 : null)

  const updateConnectionState = useCallback(
    (next: ConnectionState) => {
      connectionStateRef.current = next
      setConnectionStateState(next)
    },
    [setConnectionStateState]
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
    sessionStartedAtRef.current = null
  }, [])

  // === Callbacks for Groq translation ===
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

    setPartialTranscript(currentText)

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
    setPartialTranscript("")

    if (data.text && data.text.length > 0) {
      const finalizedText = data.text
      console.log("[v0] Final transcript received:", finalizedText)
      const now = Date.now()
      if (sessionStartedAtRef.current == null) {
        sessionStartedAtRef.current = now
      }
      const timestampMs = now - sessionStartedAtRef.current

      setTranscriptEntries((prev) => {
        const nextEntry: TranscriptEntry = {
          id: `${now}-${prev.length}`,
          text: finalizedText,
          timestampMs,
        }
        const previousEntry = prev[prev.length - 1]

        if (shouldMergeIntoPrevious(previousEntry, finalizedText, transcriptionMode)) {
          return [
            ...prev.slice(0, -1),
            mergeTranscriptEntry(previousEntry, finalizedText),
          ]
        }

        return [...prev, nextEntry]
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
    console.error("[Groq] Error:", error)

    // Ignore errors if we're not supposed to be connected
    if (connectionStateRef.current !== "connected") {
      console.log("[Groq] Ignoring error - not connected")
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

  const groqConfig = useMemo(
    () => ({
      onPartialTranscript,
      onFinalTranscript,
      onError,
    }),
    [onPartialTranscript, onFinalTranscript, onError]
  )

  const groqTranslator = useGroqRealtimeTranslation(groqConfig)

  useEffect(() => {
    if (previewOnly) return

    if (connectionState === "connecting" && groqTranslator.status === "error") {
      updateConnectionState("idle")
      setRecording((prev) => ({
        ...prev,
        error: prev.error || "Failed to connect to Groq translation.",
      }))
      return
    }

    if (connectionState === "connected" && groqTranslator.status === "error") {
      setRecording((prev) => ({
        ...prev,
        error: prev.error || "Groq translation failed while processing audio.",
      }))
      updateConnectionState("idle")
      return
    }

    if (
      connectionState === "connected" &&
      groqTranslator.status === "disconnected"
    ) {
      updateConnectionState("idle")
    }
  }, [connectionState, groqTranslator.status, previewOnly, updateConnectionState])

  useEffect(() => {
    setIsPaused(groqTranslator.status === "paused")
  }, [groqTranslator.status])

  // Clear transcript when not connected
  useEffect(() => {
    if (previewOnly) return

    if (connectionState !== "connected") {
      setTranscriptEntries([])
      setPartialTranscript("")
      setIsPaused(false)
    }
  }, [connectionState, previewOnly])

  // Simulate audio chunk timing for latency measurement
  useEffect(() => {
    if (previewOnly) return

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
  }, [connectionState, previewOnly])

  const handleToggleRecording = useCallback(async () => {
    if (previewOnly) {
      return
    }

    const now = Date.now()
    const timeSinceLastOp = now - lastOperationTimeRef.current

    // DISCONNECT
    if (connectionState === "connected" || connectionState === "connecting") {
      console.log("[Groq] Disconnecting...")

      // 1. Update UI state immediately
      updateConnectionState("idle")
      setTranscriptEntries([])
      setPartialTranscript("")
      setIsPaused(false)
      setRecording({ error: "", latenciesMs: [] })
      clearSessionRefs()

      // 2. Disconnect (async, don't wait)
      try {
        groqTranslator.disconnect()
        groqTranslator.clearTranscripts()
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
      console.log("[Groq] Ignoring rapid click")
      return
    }
    lastOperationTimeRef.current = now

    // CONNECT
    if (connectionState !== "idle") {
      console.log("[Groq] Not in idle state, ignoring")
      return
    }

    console.log("[Groq] Connecting...")
    updateConnectionState("connecting")
    setTranscriptEntries([])
    setPartialTranscript("")
    setIsPaused(false)
    setRecording({ error: "", latenciesMs: [] })
    clearSessionRefs()

    try {
      await groqTranslator.connect({
        languageCode: selectedLanguage || undefined,
        microphone: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
        transcriptionMode,
      })

      // Check again after connect completes
      if (connectionStateRef.current !== "connecting") {
        console.log("[Groq] Cancelled after connection")
        try {
          groqTranslator.disconnect()
        } catch {
          // Ignore
        }
        return
      }

      console.log("[Groq] Connected")
      sessionStartedAtRef.current = Date.now()
      updateConnectionState("connected")

      // Play start sound
      if (startSoundRef.current) {
        startSoundRef.current.currentTime = 0
        startSoundRef.current.play().catch(() => {})
      }
    } catch (error) {
      console.error("[Groq] Connection error:", error)
      updateConnectionState("idle")
      setRecording((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : "Connection failed",
      }))
    }
  }, [
    clearSessionRefs,
    connectionState,
    groqTranslator,
    previewOnly,
    selectedLanguage,
    transcriptionMode,
    updateConnectionState,
  ])

  const handlePauseToggle = useCallback(async () => {
    if (previewOnly || connectionState !== "connected") {
      return
    }

    try {
      if (groqTranslator.status === "paused") {
        await groqTranslator.resume()
        setIsPaused(false)
      } else {
        await groqTranslator.pause()
        setIsPaused(true)
      }
    } catch (error) {
      console.error("[Groq] Pause toggle error:", error)
      setRecording((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : "Pause toggle failed",
      }))
    }
  }, [connectionState, groqTranslator, previewOnly])

  // Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    if (previewOnly) return

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
  }, [handleToggleRecording, previewOnly])

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

  const combinedTranscript = [
    ...transcriptEntries.map((entry) => entry.text),
    partialTranscript,
  ]
    .filter(Boolean)
    .join(" ")
  const displayText = recording.error || combinedTranscript
  const hasContent =
    Boolean(recording.error || transcriptEntries.length || partialTranscript)

  // Determine if current transcript is partial (for styling)
  const isPartial = !previewOnly && Boolean(partialTranscript)
  const backgroundStatus =
    previewOnly
      ? "connected"
      : connectionState === "connecting"
        ? "connecting"
        : groqTranslator.status

  return (
    <div className="dark text-foreground relative min-h-screen w-full overflow-hidden bg-[#1f1f1f]">
      <div className="absolute inset-0 bg-[#1f1f1f]" />
      <div className="absolute inset-0 opacity-[0.06] [background-image:linear-gradient(rgba(255,255,255,0.14)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.14)_1px,transparent_1px)] [background-size:72px_72px]" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-4xl flex-col items-center justify-center">
      <BackgroundAura
        status={backgroundStatus}
        isConnected={previewOnly || connectionState === "connected"}
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

      <div className="relative flex min-h-screen w-full flex-col items-center justify-center gap-8 overflow-hidden px-4 py-12 sm:px-8">
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
                entries={transcriptEntries}
                error={recording.error}
                isConnected={connectionState === "connected"}
                partialTranscript={partialTranscript}
                previewOnly={previewOnly}
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
                text={
                  previewOnly
                    ? "Transcript Preview"
                    : isPaused
                      ? "Transcription paused"
                      : "Say something aloud..."
                }
                className="text-3xl font-light tracking-wide whitespace-nowrap"
              />
            </div>
          </div>

          {/* Language selector and button - only shown when not connected */}
          <div
            className={cn(
              "absolute inset-0 flex items-center justify-center transition-opacity duration-250",
              !previewOnly && connectionState === "idle"
                ? "opacity-100"
                : "pointer-events-none opacity-0"
            )}
          >
            <div className="flex w-full max-w-sm flex-col gap-4 px-4 sm:px-8">
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

                <div className="w-full flex flex-col gap-2">
                  <label className="text-foreground/70 text-sm font-medium">
                    Mode
                  </label>
                  <ToggleGroup
                    type="single"
                    value={transcriptionMode}
                    onValueChange={(value) => {
                      if (value === "conversation" || value === "sermon") {
                        setTranscriptionMode(value)
                      }
                    }}
                    variant="outline"
                    className="w-full"
                  >
                    <ToggleGroupItem value="conversation" className="flex-1">
                      Conversation
                    </ToggleGroupItem>
                    <ToggleGroupItem value="sermon" className="flex-1">
                      Sermon
                    </ToggleGroupItem>
                  </ToggleGroup>
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

        {!previewOnly && (
          <BottomControls
            isConnected={connectionState === "connected"}
            isPaused={isPaused}
            hasError={Boolean(recording.error)}
            isMac={isMac}
            onPauseToggle={handlePauseToggle}
            onStop={handleToggleRecording}
          />
        )}
      </div>
    </div>
    </div>
  )
}

const TranscriberTranscript = React.memo(
  ({
    entries,
    error,
    isConnected,
    partialTranscript,
    previewOnly,
  }: {
    entries: TranscriptEntry[]
    error: string
    isConnected: boolean
    partialTranscript?: string
    previewOnly?: boolean
  }) => {
    const topFogHeightClass = previewOnly ? "h-28" : "h-24"
    const viewportHeightClass = previewOnly
      ? "h-[min(42vh,26rem)]"
      : "h-[min(40vh,24rem)]"
    const entryFragments = useMemo(
      () =>
        entries.map((entry) => ({
          entry,
          fragments: getBibleReferenceFragments(entry.text),
        })),
      [entries]
    )
    const partialFragments = useMemo(
      () => getBibleReferenceFragments(partialTranscript || ""),
      [partialTranscript]
    )
    const totalCharacters = useMemo(
      () =>
        entryFragments.reduce(
          (sum, item) =>
            sum +
            item.fragments.reduce(
              (fragmentSum, fragment) => fragmentSum + fragment.text.length,
              0
            ),
          0
        ) + partialFragments.reduce((sum, fragment) => sum + fragment.text.length, 0),
      [entryFragments, partialFragments]
    )
    const previousNumChars = useDebounce(
      usePrevious(totalCharacters) || 0,
      100
    )
    const scrollRef = useRef<HTMLDivElement>(null)
    const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const shouldAutoScrollRef = useRef(true)
    const [chapterLookups, setChapterLookups] = useState<
      Record<string, BibleVerseLookupState>
    >({})

    const ensureVerseLookup = useCallback(async (query?: string) => {
      if (!query) return

      const chapterQuery = query.replace(/([:.]\d+(?:-\d+)?)$/u, "")
      const cacheKey = chapterQuery.trim()
      const existing = chapterLookups[cacheKey]
      if (existing?.loading || existing?.data) {
        return
      }

      setChapterLookups((prev) => ({
        ...prev,
        [cacheKey]: { ...prev[cacheKey], loading: true, error: undefined },
      }))

      try {
        const data = await fetchBibleVerse(cacheKey)
        setChapterLookups((prev) => ({
          ...prev,
          [cacheKey]: { data, loading: false },
        }))
      } catch (error) {
        setChapterLookups((prev) => ({
          ...prev,
          [cacheKey]: {
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "Unable to load verse.",
          },
        }))
      }
    }, [chapterLookups])

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
    }, [entries, isConnected, partialTranscript])

    return (
      <div className="absolute inset-0 flex flex-col">
        <div className="flex flex-1 items-center justify-center">
          <div
            className={cn(
              "relative w-full -translate-y-[16vh]",
              viewportHeightClass
            )}
          >
            <div className="absolute inset-0 overflow-hidden">
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="minimal-scrollbar h-full overflow-y-auto"
              >
                <div
                  className={cn(
                    "flex min-h-full w-full flex-col justify-end px-5 sm:px-12",
                    previewOnly ? "pt-16 pb-10" : "pt-14 pb-8"
                  )}
                >
                <div
                  className="flex w-full flex-col gap-4"
                >
                  {(() => {
                    let charOffset = 0

                    return (
                      <>
                        {entryFragments.map(({ entry, fragments }, entryIndex) => (
                          <div
                            key={entry.id}
                            className="grid grid-cols-[3.5rem_1fr] items-start gap-3 sm:grid-cols-[4.5rem_1fr] sm:gap-4"
                          >
                            <div className="text-muted-foreground/70 pt-1 text-[11px] font-medium tracking-[0.16em] uppercase">
                              {formatElapsedTime(entry.timestampMs)}
                            </div>
                            <div
                              className={cn(
                                "text-foreground/90 text-xl leading-relaxed font-light",
                                error && "text-red-500"
                              )}
                            >
                              {fragments.map((fragment, fragmentIndex) => {
                                const fragmentStart = charOffset
                                charOffset += fragment.text.length

                                return fragment.highlighted && fragment.query ? (
                                  <BibleReferencePopover
                                    key={`${entry.id}-${fragment.osis || "text"}-${fragmentIndex}-${fragmentStart}`}
                                    fragment={fragment}
                                    fragmentIndex={entryIndex * 1000 + fragmentIndex}
                                    fragmentStart={fragmentStart}
                                    previousNumChars={previousNumChars}
                                    lookupState={
                                      fragment.query
                                        ? chapterLookups[
                                            fragment.query
                                              .replace(/([:.]\d+(?:-\d+)?)$/u, "")
                                              .trim()
                                          ]
                                        : undefined
                                    }
                                    onOpen={() => void ensureVerseLookup(fragment.query)}
                                  />
                                ) : (
                                  <span
                                    key={`${entry.id}-${fragment.osis || "text"}-${fragmentIndex}-${fragmentStart}`}
                                  >
                                    {fragment.text.split("").map((char, index) => {
                                      const globalIndex = fragmentStart + index
                                      const delay =
                                        globalIndex >= previousNumChars
                                          ? (globalIndex - previousNumChars + 1) *
                                            0.012
                                          : 0

                                      return (
                                        <TranscriptCharacter
                                          key={`${entry.id}-${fragmentIndex}-${globalIndex}`}
                                          char={char}
                                          delay={delay}
                                        />
                                      )
                                    })}
                                  </span>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                        {!error && partialFragments.length > 0 && (
                          <div className="grid grid-cols-[3.5rem_1fr] items-start gap-3 sm:grid-cols-[4.5rem_1fr] sm:gap-4">
                            <div className="text-muted-foreground/45 pt-1 text-[11px] font-medium tracking-[0.16em] uppercase">
                              Live
                            </div>
                            <div className="text-foreground/60 text-xl leading-relaxed font-light">
                              {partialFragments.map((fragment, fragmentIndex) => {
                                const fragmentStart = charOffset
                                charOffset += fragment.text.length

                                return fragment.highlighted && fragment.query ? (
                                  <BibleReferencePopover
                                    key={`partial-${fragment.osis || "text"}-${fragmentIndex}-${fragmentStart}`}
                                    fragment={fragment}
                                    fragmentIndex={90000 + fragmentIndex}
                                    fragmentStart={fragmentStart}
                                    previousNumChars={previousNumChars}
                                    lookupState={
                                      fragment.query
                                        ? chapterLookups[
                                            fragment.query
                                              .replace(/([:.]\d+(?:-\d+)?)$/u, "")
                                              .trim()
                                          ]
                                        : undefined
                                    }
                                    onOpen={() => void ensureVerseLookup(fragment.query)}
                                  />
                                ) : (
                                  <span
                                    key={`partial-${fragment.osis || "text"}-${fragmentIndex}-${fragmentStart}`}
                                  >
                                    {fragment.text.split("").map((char, index) => {
                                      const globalIndex = fragmentStart + index
                                      const delay =
                                        globalIndex >= previousNumChars
                                          ? (globalIndex - previousNumChars + 1) *
                                            0.012
                                          : 0

                                      return (
                                        <TranscriptCharacter
                                          key={`partial-${fragmentIndex}-${globalIndex}`}
                                          char={char}
                                          delay={delay}
                                        />
                                      )
                                    })}
                                  </span>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>
              </div>
            </div>
            </div>
            <div
              className={cn(
                "pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-[#1f1f1f] via-[rgba(31,31,31,0.84)] to-transparent backdrop-blur-[3px] z-20",
                topFogHeightClass
              )}
            />
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
        {(entries.length > 0 || partialTranscript) && !error && !partialTranscript && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-4 right-4 h-8 w-8 opacity-0 transition-opacity hover:opacity-60"
            onClick={() => {
              navigator.clipboard.writeText(entries.map((entry) => entry.text).join(" "))
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

const BibleReferencePopover = React.memo(
  ({
    fragment,
    fragmentIndex,
    fragmentStart,
    previousNumChars,
    lookupState,
    onOpen,
  }: {
    fragment: ReturnType<typeof getBibleReferenceFragments>[number]
    fragmentIndex: number
    fragmentStart: number
    previousNumChars: number
    lookupState?: BibleVerseLookupState
    onOpen: () => void
  }) => {
    const normalizedReferenceText = fragment.text.replace(/\s+/g, " ").trim()
    const hasExplicitVerseSyntax =
      /[:.]\s*\d/u.test(normalizedReferenceText) ||
      /\bverses?\s+\d/u.test(normalizedReferenceText) ||
      /(?:-|–|—|\bto\b|\bthrough\b)\s*\d/u.test(normalizedReferenceText)
    const isChapterReference =
      typeof fragment.chapter === "number" && !hasExplicitVerseSyntax
    const baseStartVerse = fragment.startVerse ?? 1
    const baseEndVerse = fragment.endVerse ?? (
      isChapterReference
        ? baseStartVerse + CHAPTER_VERSES_PER_PAGE - 1
        : baseStartVerse
    )
    const initialEndVerse = isChapterReference
      ? baseStartVerse + CHAPTER_VERSES_PER_PAGE - 1
      : baseEndVerse
    const [visibleRange, setVisibleRange] = useState({
      end: initialEndVerse,
      start: baseStartVerse,
    })

    useEffect(() => {
      setVisibleRange({
        end: isChapterReference
          ? baseStartVerse + CHAPTER_VERSES_PER_PAGE - 1
          : baseEndVerse,
        start: baseStartVerse,
      })
    }, [baseEndVerse, baseStartVerse, fragment.osis, isChapterReference])

    const maxVerseNumber = useMemo(() => {
      if (!lookupState?.data?.verses?.length) {
        return baseEndVerse
      }

      return lookupState.data.verses[lookupState.data.verses.length - 1]?.verse ?? baseEndVerse
    }, [baseEndVerse, lookupState?.data?.verses])

    const visibleVerses = useMemo(() => {
      if (!lookupState?.data?.verses?.length) {
        return []
      }

      return lookupState.data.verses.filter(
        (verse) =>
          verse.verse >= visibleRange.start && verse.verse <= visibleRange.end
      )
    }, [lookupState?.data?.verses, visibleRange.end, visibleRange.start])

    const canGoPrevious = visibleRange.start > 1
    const canGoNext = Boolean(
      lookupState?.data?.verses?.some((verse) => verse.verse > visibleRange.end)
    )

    const shiftRange = useCallback((direction: -1 | 1) => {
      setVisibleRange((current) => {
        if (isChapterReference) {
          const nextStart = Math.max(
            1,
            Math.min(
              maxVerseNumber - CHAPTER_VERSES_PER_PAGE + 1,
              current.start + direction * CHAPTER_VERSES_PER_PAGE
            )
          )
          const boundedStart = Number.isFinite(nextStart) ? nextStart : 1

          return {
            start: boundedStart,
            end: Math.min(
              maxVerseNumber,
              boundedStart + CHAPTER_VERSES_PER_PAGE - 1
            ),
          }
        }

        const span = current.end - current.start
        const nextStart = Math.max(1, current.start + direction)
        const nextEnd = Math.min(
          maxVerseNumber,
          Math.max(nextStart, current.end + direction)
        )

        return span > 0
          ? {
              start: nextStart,
              end: Math.min(maxVerseNumber, nextStart + span),
            }
          : { start: nextStart, end: nextEnd }
      })
    }, [isChapterReference, maxVerseNumber])

    return (
      <Popover onOpenChange={(open) => open && onOpen()}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="bg-sky-200/18 ring-sky-100/28 text-sky-50 rounded-md px-1 py-0.5 ring-1 transition-colors hover:bg-sky-200/24"
          >
            {fragment.text.split("").map((char, index) => {
              const globalIndex = fragmentStart + index
              const delay =
                globalIndex >= previousNumChars
                  ? (globalIndex - previousNumChars + 1) * 0.012
                  : 0

              return (
                <TranscriptCharacter
                  key={`${fragmentIndex}-${globalIndex}`}
                  char={char}
                  delay={delay}
                />
              )
            })}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={14}
          className="w-80 rounded-xl p-0"
        >
          <div className="flex flex-col gap-4 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">{fragment.text}</p>
                {lookupState?.data?.bookName && lookupState?.data?.chapter > 0 && (
                  <p className="text-muted-foreground text-xs">
                    {lookupState.data.bookName} {lookupState.data.chapter}
                  </p>
                )}
              </div>
              <Badge variant="secondary">
                {lookupState?.data?.translationId?.toUpperCase() || "KJV"}
              </Badge>
            </div>
            {lookupState?.loading ? (
              <div className="flex items-center gap-2 text-sm">
                <Spinner />
                <span className="text-muted-foreground">Loading verse...</span>
              </div>
            ) : lookupState?.error ? (
              <p className="text-muted-foreground text-sm">
                Unable to load this verse right now.
              </p>
            ) : visibleVerses.length > 0 ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => shiftRange(-1)}
                    disabled={!canGoPrevious}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30 text-xs transition-colors"
                  >
                    Prev
                  </button>
                  <p className="text-muted-foreground text-xs">
                    {isChapterReference
                      ? `Verses ${visibleRange.start}-${visibleRange.end} of ${maxVerseNumber}`
                      : visibleRange.start === visibleRange.end
                      ? `Verse ${visibleRange.start}`
                      : `Verses ${visibleRange.start}-${visibleRange.end}`}
                  </p>
                  <button
                    type="button"
                    onClick={() => shiftRange(1)}
                    disabled={!canGoNext}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30 text-xs transition-colors"
                  >
                    Next
                  </button>
                </div>
                <div className="flex flex-col gap-3">
                  {visibleVerses.map((verse) => (
                    <div key={verse.verse} className="grid grid-cols-[1.75rem_1fr] gap-3">
                      <span className="text-muted-foreground pt-0.5 text-[11px] font-medium">
                        {verse.verse}
                      </span>
                      <p className="text-sm leading-6">{verse.text}</p>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">
                Open to load the verse text.
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    )
  }
)
BibleReferencePopover.displayName = "BibleReferencePopover"
