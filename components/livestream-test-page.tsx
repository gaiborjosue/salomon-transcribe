"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { ShimmeringText } from "@/components/ui/shimmering-text"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  BackgroundAura,
  BottomControls,
  TranscriberTranscript,
  type TranscriptEntry,
} from "@/components/transcriber-ui"
import { useLivestreamTranslation } from "@/hooks/use-livestream-translation"
import {
  mergeTranscriptEntry,
  shouldMergeIntoPrevious,
} from "@/lib/transcript-text-utils"
import { cn } from "@/lib/utils"

type TranscriptionMode = "conversation" | "sermon"

export default function LivestreamTestPage() {
  const [sourceUrl, setSourceUrl] = useState("")
  const [recordingError, setRecordingError] = useState("")
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([])
  const [isPaused, setIsPaused] = useState(false)
  const [transcriptionMode, setTranscriptionMode] =
    useState<TranscriptionMode>("conversation")
  const [isMac, setIsMac] = useState(true)
  const [sourceTitle, setSourceTitle] = useState("")

  const startSoundRef = useRef<HTMLAudioElement | null>(null)
  const endSoundRef = useRef<HTMLAudioElement | null>(null)
  const errorSoundRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    setIsMac(/(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent))
  }, [])

  const livestreamTranslator = useLivestreamTranslation({
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : "Livestream transcription failed."
      setRecordingError(message)
      errorSoundRef.current?.play().catch(() => {})
    },
    onFinalTranscript: (entry) => {
      setTranscriptEntries((prev) => {
        const previousEntry = prev[prev.length - 1]
        if (shouldMergeIntoPrevious(previousEntry, entry.text, transcriptionMode)) {
          return [
            ...prev.slice(0, -1),
            mergeTranscriptEntry(previousEntry as TranscriptEntry, entry.text),
          ]
        }

        return [...prev, entry]
      })
    },
    onSnapshot: (snapshot) => {
      setTranscriptEntries(snapshot.segments)
      setSourceTitle(snapshot.sourceTitle || "")
      setRecordingError(snapshot.error || "")
      setIsPaused(snapshot.status === "paused")
    },
    onStatusChange: ({ error, sourceTitle: nextSourceTitle, status }) => {
      if (typeof nextSourceTitle === "string") {
        setSourceTitle(nextSourceTitle)
      }
      setIsPaused(status === "paused")
      if (error) {
        setRecordingError(error)
      }
    },
  })

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

  const status = livestreamTranslator.status
  const isConnected =
    status === "connected" || status === "paused" || status === "transcribing"
  const hasContent = Boolean(recordingError || transcriptEntries.length)

  const handleToggleRecording = useCallback(async () => {
    if (isConnected || status === "connecting") {
      await livestreamTranslator.disconnect()
      setTranscriptEntries([])
      setRecordingError("")
      setSourceTitle("")
      setIsPaused(false)
      endSoundRef.current?.play().catch(() => {})
      return
    }

    const trimmedUrl = sourceUrl.trim()
    if (!trimmedUrl) {
      setRecordingError("Paste a YouTube livestream URL to start.")
      return
    }

    setTranscriptEntries([])
    setRecordingError("")
    setSourceTitle("")
    setIsPaused(false)

    try {
      await livestreamTranslator.connect({
        streamUrl: trimmedUrl,
        transcriptionMode,
      })
      startSoundRef.current?.play().catch(() => {})
    } catch {
      // handled by hook callbacks
    }
  }, [isConnected, livestreamTranslator, sourceUrl, status, transcriptionMode])

  const handlePauseToggle = useCallback(async () => {
    try {
      if (status === "paused") {
        await livestreamTranslator.resume()
      } else {
        await livestreamTranslator.pause()
      }
    } catch {
      // handled by hook callbacks
    }
  }, [livestreamTranslator, status])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "k" &&
        (event.metaKey || event.ctrlKey) &&
        event.target instanceof HTMLElement &&
        !["INPUT", "TEXTAREA"].includes(event.target.tagName)
      ) {
        event.preventDefault()
        void handleToggleRecording()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [handleToggleRecording])

  const statusText = useMemo(() => {
    if (status === "connecting") return "Connecting to livestream..."
    if (status === "paused") return "Livestream paused"
    if (status === "transcribing") return "Translating livestream..."
    if (status === "connected") return "Listening to livestream..."
    return "Paste a YouTube livestream URL to begin"
  }, [status])

  return (
    <div className="dark text-foreground relative min-h-screen w-full overflow-hidden bg-[#1f1f1f]">
      <div className="absolute inset-0 bg-[#1f1f1f]" />
      <div className="absolute inset-0 opacity-[0.06] [background-image:linear-gradient(rgba(255,255,255,0.14)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.14)_1px,transparent_1px)] [background-size:72px_72px]" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-4xl flex-col items-center justify-center">
        <BackgroundAura status={status} isConnected={isConnected} />

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
          <div className="relative flex min-h-[350px] w-full flex-1 items-center justify-center overflow-hidden">
            <div
              className={cn(
                "absolute inset-0 transition-opacity duration-250",
                hasContent ? "opacity-100" : "pointer-events-none opacity-0"
              )}
            >
              {hasContent && (
                <>
                  {sourceTitle ? (
                    <div className="absolute top-4 left-4 z-20 max-w-[min(80vw,28rem)] rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 backdrop-blur-md">
                      {sourceTitle}
                    </div>
                  ) : null}
                  <TranscriberTranscript
                    entries={transcriptEntries}
                    error={recordingError}
                    isConnected={isConnected}
                    partialTranscript=""
                  />
                </>
              )}
            </div>

            <div
              className={cn(
                "absolute inset-0 flex items-center justify-center transition-opacity duration-250",
                !hasContent ? "opacity-100" : "pointer-events-none opacity-0"
              )}
            >
              {(status === "connecting" ||
                status === "connected" ||
                status === "paused" ||
                status === "transcribing") && (
                <ShimmeringText
                  text={statusText}
                  className="text-3xl font-light tracking-wide whitespace-nowrap"
                />
              )}
            </div>

            <div
              className={cn(
                "absolute inset-0 flex items-center justify-center transition-opacity duration-250",
                !isConnected && status !== "connecting"
                  ? "opacity-100"
                  : "pointer-events-none opacity-0"
              )}
            >
              <div className="flex w-full max-w-sm flex-col gap-4 px-4 sm:px-8">
                <div className="flex flex-col items-center gap-6">
                  <div className="flex flex-col items-center gap-2 text-center">
                    <h1 className="text-2xl font-semibold tracking-tight">
                      Livestream Translation
                    </h1>
                    <p className="text-muted-foreground text-sm">
                      Pull live audio from a YouTube livestream and translate it to English
                    </p>
                  </div>

                  <div className="w-full space-y-2">
                    <label className="text-foreground/70 text-sm font-medium">
                      YouTube Livestream URL
                    </label>
                    <Input
                      value={sourceUrl}
                      onChange={(event) => setSourceUrl(event.target.value)}
                      placeholder="https://www.youtube.com/watch?v=..."
                      className="bg-background/50 border-border/60 h-12"
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

                  {recordingError ? (
                    <p className="w-full text-sm text-red-400">{recordingError}</p>
                  ) : (
                    <p className="w-full text-xs text-white/45">
                      This flow expects `yt-dlp` and `ffmpeg` to be available locally.
                    </p>
                  )}

                  <Button
                    onClick={() => void handleToggleRecording()}
                    size="lg"
                    className="bg-foreground/95 hover:bg-foreground/90 w-full justify-center gap-3"
                  >
                    <span>Start Livestream</span>
                    <kbd className="border-background/20 bg-background/10 hidden h-5 items-center gap-1 rounded border px-1.5 font-mono text-xs sm:inline-flex">
                      {isMac ? "⌘K" : "Ctrl+K"}
                    </kbd>
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <BottomControls
            isConnected={isConnected}
            isPaused={isPaused}
            hasError={Boolean(recordingError)}
            isMac={isMac}
            onPauseToggle={() => void handlePauseToggle()}
            onStop={() => void handleToggleRecording()}
          />
        </div>
      </div>
    </div>
  )
}
