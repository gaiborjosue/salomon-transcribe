"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Info,
  Pause,
  Play,
  RadioTower,
  RefreshCw,
  Square,
} from "lucide-react"
import { toast } from "sonner"

import {
  BackgroundAura,
  TranscriberTranscript,
  type TranscriptEntry,
} from "@/components/transcriber-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { TranscriptSessionSummary } from "@/lib/transcript-session-types"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type {
  RtmpSessionSnapshot,
  RtmpSessionStatus,
  RtmpSessionSummary,
} from "@/lib/rtmp-types"

interface HostSession {
  snapshot: RtmpSessionSnapshot
}

interface ResumableSession {
  snapshot: RtmpSessionSummary
}

function StreamKeyField({ value }: { value: string }) {
  const [isHovering, setIsHovering] = useState(false)
  const [pointer, setPointer] = useState({ x: 0, y: 0 })

  return (
    <div
      className="group relative h-11 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        setPointer({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        })
      }}
    >
      <div className="absolute inset-0 flex items-center px-3 text-sm tracking-[0.16em] text-white/84">
        {value}
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 hidden md:block"
        style={{
          WebkitMaskImage: isHovering
            ? `radial-gradient(circle 56px at ${pointer.x}px ${pointer.y}px, transparent 0, transparent 38px, black 72px)`
            : undefined,
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.08) 100%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 md:hidden"
        style={{
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.07) 100%)",
        }}
      />
      <div className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-black/12 to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-black/12 to-transparent" />
    </div>
  )
}

function InlineAdvancedField({
  label,
  onCopy,
  value,
}: {
  label: string
  onCopy: () => Promise<void>
  value: string
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    await onCopy()
    setCopied(true)
    window.setTimeout(() => {
      setCopied(false)
    }, 2200)
  }, [onCopy])

  return (
    <div className="min-w-0 flex-1 rounded-[20px] border border-white/10 bg-black/20 px-3 py-2.5">
      <div className="mb-1.5 text-[10px] tracking-[0.16em] uppercase text-white/40">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-sm text-white/76 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {value}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-full border border-white/10 bg-white/[0.03] text-white/60 hover:bg-white/10 hover:text-white"
          onClick={() => void handleCopy()}
        >
          <AnimatePresence mode="wait" initial={false}>
            {copied ? (
              <motion.span
                key="check"
                initial={{ opacity: 0, rotate: -18, scale: 0.82, y: 2 }}
                animate={{ opacity: 1, rotate: 0, scale: 1, y: 0 }}
                exit={{ opacity: 0, rotate: 14, scale: 0.82, y: -2 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="inline-flex"
              >
                <Check className="h-3.5 w-3.5" />
              </motion.span>
            ) : (
              <motion.span
                key="copy"
                initial={{ opacity: 0, rotate: 18, scale: 0.82, y: 2 }}
                animate={{ opacity: 1, rotate: 0, scale: 1, y: 0 }}
                exit={{ opacity: 0, rotate: -14, scale: 0.82, y: -2 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="inline-flex"
              >
                <Copy className="h-3.5 w-3.5" />
              </motion.span>
            )}
          </AnimatePresence>
        </Button>
      </div>
    </div>
  )
}

export function RtmpIngestPage() {
  const [hostSession, setHostSession] = useState<HostSession | null>(null)
  const [availableSessions, setAvailableSessions] = useState<ResumableSession[]>([])
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [status, setStatus] = useState<RtmpSessionStatus>("disconnected")
  const [error, setError] = useState("")
  const [isStarting, setIsStarting] = useState(false)
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [copiedField, setCopiedField] = useState<
    "ffmpegCommand" | "publishUrl" | "streamKey" | null
  >(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const copiedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const closeEvents = useCallback(() => {
    eventSourceRef.current?.close()
    eventSourceRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      closeEvents()
      if (copiedResetTimerRef.current) {
        clearTimeout(copiedResetTimerRef.current)
        copiedResetTimerRef.current = null
      }
    }
  }, [closeEvents])

  const loadAvailableSessions = useCallback(async () => {
    setIsLoadingSessions(true)

    try {
      const response = await fetch("/api/rtmp-sessions")
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; sessions?: ResumableSession[] }
        | null

      if (!response.ok || !payload?.sessions) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to load active RTMP sessions."
        )
      }

      setAvailableSessions(payload.sessions)
    } catch (nextError) {
      const message =
        nextError instanceof Error
          ? nextError.message
          : "Unable to load active RTMP sessions."
      setError(message)
    } finally {
      setIsLoadingSessions(false)
    }
  }, [])

  useEffect(() => {
    if (!hostSession) {
      void loadAvailableSessions()
    }
  }, [hostSession, loadAvailableSessions])

  const subscribe = useCallback(
    (session: HostSession) => {
      closeEvents()

      const eventSource = new EventSource(
        `/api/rtmp-sessions/${session.snapshot.id}/events`
      )
      eventSourceRef.current = eventSource

      eventSource.addEventListener("snapshot", (event) => {
        const snapshot = JSON.parse(
          (event as MessageEvent<string>).data
        ) as RtmpSessionSnapshot
        setHostSession((prev) =>
          prev
            ? {
                ...prev,
                snapshot,
              }
            : { snapshot }
        )
        setEntries(snapshot.entries)
        setStatus(snapshot.status)
        setError(snapshot.error || "")
      })

      eventSource.addEventListener("entry", (event) => {
        const entry = JSON.parse(
          (event as MessageEvent<string>).data
        ) as TranscriptEntry
        setEntries((prev) => [...prev, entry])
        setError("")
      })

      eventSource.addEventListener("status", (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          error?: string
          status: RtmpSessionStatus
        }
        setStatus(payload.status)
        setError(payload.error || "")
      })

      eventSource.onerror = () => {
        if (eventSource.readyState === EventSource.CLOSED) {
          toast.error("RTMP session connection was interrupted.")
        }
      }
    },
    [closeEvents]
  )

  const handleStart = useCallback(async () => {
    setIsStarting(true)
    setError("")

    try {
      const response = await fetch("/api/rtmp-sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      })

      const payload = (await response.json().catch(() => null)) as
        | { error?: string; snapshot?: RtmpSessionSnapshot }
        | null

      if (!response.ok || !payload?.snapshot) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to start the RTMP session."
        )
      }

      const session = { snapshot: payload.snapshot }

      setHostSession(session)
      setAvailableSessions((prev) =>
        prev.filter((item) => item.snapshot.id !== payload.snapshot?.id)
      )
      setEntries(payload.snapshot.entries)
      setStatus(payload.snapshot.status)
      subscribe(session)
    } catch (nextError) {
      const message =
        nextError instanceof Error
          ? nextError.message
          : "Unable to start the RTMP session."
      setError(message)
      toast.error(message)
    } finally {
      setIsStarting(false)
    }
  }, [subscribe])

  const handleResume = useCallback(
    async (sessionToResume: ResumableSession) => {
      try {
        const response = await fetch(`/api/rtmp-sessions/${sessionToResume.snapshot.id}`)
        const payload = (await response.json().catch(() => null)) as
          | { error?: string; snapshot?: RtmpSessionSnapshot }
          | null

        if (!response.ok || !payload?.snapshot) {
          throw new Error(
            typeof payload?.error === "string"
              ? payload.error
              : "Unable to resume the RTMP session."
          )
        }

        const session = { snapshot: payload.snapshot }

        setHostSession(session)
        setEntries(payload.snapshot.entries)
        setStatus(payload.snapshot.status)
        setError(payload.snapshot.error || "")
        subscribe(session)
      } catch (nextError) {
        const message =
          nextError instanceof Error
            ? nextError.message
            : "Unable to resume the RTMP session."
        setError(message)
        toast.error(message)
      }
    },
    [subscribe]
  )

  const handleStop = useCallback(async () => {
    const session = hostSession
    if (!session) {
      return
    }

    try {
      const response = await fetch(`/api/rtmp-sessions/${session.snapshot.id}/control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "stop",
        }),
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to end the RTMP session."
        )
      }

      if (entries.length > 0) {
        const saveResponse = await fetch("/api/transcript-sessions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            endedAt: Date.now(),
            entries,
            sourceType: "rtmp",
            startedAt: session.snapshot.createdAt,
            title: "RTMP ingest",
          }),
        })

        const savePayload = (await saveResponse.json().catch(() => null)) as
          | { error?: string; session?: { summary?: TranscriptSessionSummary } | null }
          | null

        if (!saveResponse.ok) {
          throw new Error(
            typeof savePayload?.error === "string"
              ? savePayload.error
              : "Unable to save the transcript session."
          )
        }
      }
    } catch (nextError) {
      const message =
        nextError instanceof Error
          ? nextError.message
          : "Unable to end the RTMP session."
      setError(message)
      toast.error(message)
    } finally {
      closeEvents()
      setHostSession(null)
      await loadAvailableSessions()
      setEntries([])
      setStatus("disconnected")
      setError("")
    }
  }, [closeEvents, entries, hostSession, loadAvailableSessions])

  const handlePauseToggle = useCallback(async () => {
    const session = hostSession
    if (!session) {
      return
    }

    const action = status === "paused" ? "resume" : "pause"

    try {
      const response = await fetch(`/api/rtmp-sessions/${session.snapshot.id}/control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
        }),
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : `Unable to ${action} the session.`
        )
      }

      setStatus(action === "pause" ? "paused" : "connected")
      setError("")
    } catch (nextError) {
      const message =
        nextError instanceof Error
          ? nextError.message
          : `Unable to ${action} the session.`
      setError(message)
      toast.error(message)
    }
  }, [hostSession, status])

  const handleCopy = useCallback(
    async (
      value: string,
      label: string,
      field: "ffmpegCommand" | "publishUrl" | "streamKey"
    ) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(field)
      if (copiedResetTimerRef.current) {
        clearTimeout(copiedResetTimerRef.current)
      }
      copiedResetTimerRef.current = setTimeout(() => {
        setCopiedField(null)
        copiedResetTimerRef.current = null
      }, 2200)
      toast.success(`${label} copied.`)
    } catch {
      toast.error(`Unable to copy the ${label.toLowerCase()}.`)
    }
    },
    []
  )

  const renderCopyIcon = useCallback(
    (field: "ffmpegCommand" | "publishUrl" | "streamKey") => (
      <AnimatePresence mode="wait" initial={false}>
        {copiedField === field ? (
          <motion.span
            key="check"
            initial={{ opacity: 0, rotate: -18, scale: 0.82, y: 2 }}
            animate={{ opacity: 1, rotate: 0, scale: 1, y: 0 }}
            exit={{ opacity: 0, rotate: 14, scale: 0.82, y: -2 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="inline-flex"
          >
            <Check className="h-4 w-4" />
          </motion.span>
        ) : (
          <motion.span
            key="copy"
            initial={{ opacity: 0, rotate: 18, scale: 0.82, y: 2 }}
            animate={{ opacity: 1, rotate: 0, scale: 1, y: 0 }}
            exit={{ opacity: 0, rotate: -14, scale: 0.82, y: -2 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="inline-flex"
          >
            <Copy className="h-4 w-4" />
          </motion.span>
        )}
      </AnimatePresence>
    ),
    [copiedField]
  )

  const isActive = Boolean(hostSession)
  const isConnected =
    status === "connected" ||
    status === "connecting" ||
    status === "transcribing" ||
    status === "paused"
  const publishBaseUrl = hostSession
    ? hostSession.snapshot.publishUrl.replace(/\/[^/]+$/u, "")
    : ""
  const ffmpegPublishCommand = useMemo(() => {
    if (!hostSession) {
      return ""
    }

    return `ffmpeg -f avfoundation -i ":0" -vn -ac 1 -ar 48000 -c:a aac -b:a 128k -f flv ${publishBaseUrl}/${hostSession.snapshot.streamKey}`
  }, [hostSession, publishBaseUrl])
  const statusLabel = useMemo(() => {
    if (status === "connecting") {
      return "Waiting for encoder"
    }
    if (status === "transcribing") {
      return "Transcribing"
    }
    if (status === "connected") {
      return "Receiving stream"
    }
    if (status === "paused") {
      return "Processing paused"
    }
    if (status === "error") {
      return "Error"
    }
    return "Disconnected"
  }, [status])

  return (
    <main className="dark text-foreground relative min-h-[100dvh] overflow-hidden bg-[#1f1f1f] text-white">
      <BackgroundAura status={status} isConnected={isConnected} />

      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-5xl flex-col px-5 py-6 sm:px-8">
        <div className="flex items-center justify-between gap-4">
          <Button
            asChild
            variant="ghost"
            className="rounded-full border border-white/10 bg-black/20 px-4 text-white/70 hover:bg-white/8 hover:text-white"
          >
            <Link href="/">Back</Link>
          </Button>
          <div className="rounded-full border border-white/10 bg-black/25 px-3 py-1.5 text-[11px] tracking-[0.18em] uppercase text-white/50">
            Advanced RTMP
          </div>
        </div>

        {!isActive ? (
          <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center">
            <div className="w-full space-y-8">
              <div className="space-y-3 text-center">
                <h1 className="text-3xl font-semibold tracking-tight text-white/92 sm:text-4xl">
                  RTMP ingest
                </h1>
                <p className="mx-auto max-w-xl text-sm leading-6 text-white/48">
                  Publish one encoder feed from OBS or vMix, then let Salomon
                  translate and distribute the transcript from a single source.
                </p>
              </div>

              <div className="grid gap-3 rounded-[28px] border border-white/10 bg-black/20 p-4 sm:p-5">
                <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 rounded-full border border-cyan-400/20 bg-cyan-400/10 p-2 text-cyan-200">
                      <RadioTower className="h-4 w-4" />
                    </div>
                    <div className="space-y-1">
                      <div className="text-sm font-medium text-white/88">
                        Use this for production encoders
                      </div>
                      <p className="text-sm leading-6 text-white/50">
                        Start the RTMP session here, point your encoder to the generated
                        stream URL and key, and the transcript will appear as soon as
                        audio arrives.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-white/42">
                  Requires the local ingest worker and <code className="text-white/58">mediamtx</code>{" "}
                  to be running.
                </div>

                <Button
                  onClick={handleStart}
                  disabled={isStarting}
                  className="h-12 rounded-full bg-white text-black hover:bg-white/92"
                >
                  {isStarting ? "Creating RTMP session..." : "Create RTMP session"}
                </Button>
              </div>

              {availableSessions.length > 0 ? (
                <div className="space-y-3 rounded-[28px] border border-white/10 bg-black/20 p-4 sm:p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-sm font-medium text-white/86">
                        Active RTMP sessions
                      </div>
                      <p className="text-sm leading-6 text-white/48">
                        Re-enter an ongoing encoder session without stopping transcription.
                      </p>
                    </div>
                    <Button
                      onClick={() => void loadAvailableSessions()}
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10 rounded-full border border-white/10 bg-black/20 text-white/70 hover:bg-white/8 hover:text-white"
                    >
                      <RefreshCw
                        className={`h-4 w-4 ${isLoadingSessions ? "animate-spin" : ""}`}
                      />
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {availableSessions.map((sessionItem) => (
                      <div
                        key={sessionItem.snapshot.id}
                        className="flex items-center justify-between gap-3 rounded-[20px] border border-white/10 bg-white/[0.03] px-4 py-3"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-white/84">
                            {sessionItem.snapshot.status === "paused"
                              ? "Paused session"
                              : sessionItem.snapshot.status === "connected" ||
                                  sessionItem.snapshot.status === "transcribing"
                                ? "Live now"
                                : "Ready to publish"}
                          </div>
                          <div className="mt-1 text-xs text-white/46">
                            {sessionItem.snapshot.id}
                          </div>
                          <div className="mt-1 text-xs tracking-[0.14em] text-white/56">
                            {sessionItem.snapshot.streamKey}
                          </div>
                        </div>
                        <Button
                          onClick={() => void handleResume(sessionItem)}
                          variant="ghost"
                          className="h-10 rounded-full border border-white/10 bg-black/20 px-4 text-white/72 hover:bg-white/8 hover:text-white"
                        >
                          Resume
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {error ? (
                <div className="text-center text-sm text-red-300/78">{error}</div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pt-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="text-[11px] tracking-[0.18em] uppercase text-white/42">
                    RTMP session
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-2xl font-semibold tracking-tight text-white/92">
                      {statusLabel}
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-black/18 text-white/48 transition-colors hover:border-white/16 hover:text-white/72"
                          aria-label="RTMP session details"
                        >
                          <Info className="h-4 w-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        sideOffset={10}
                        className="max-w-[280px] rounded-2xl border border-white/10 bg-black/88 px-4 py-3 text-xs leading-5 text-white/72 shadow-2xl"
                      >
                        Point OBS or vMix to the publish URL above, use the stream key,
                        and keep the encoder audio at a consistent source mix.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={handlePauseToggle}
                    variant="ghost"
                    className="rounded-full border border-white/10 bg-black/25 px-4 text-white/74 hover:bg-white/8 hover:text-white"
                  >
                    {status === "paused" ? (
                      <Play className="mr-2 h-4 w-4 fill-current" />
                    ) : (
                      <Pause className="mr-2 h-4 w-4" />
                    )}
                    {status === "paused" ? "Resume session" : "Pause session"}
                  </Button>
                  <Button
                    onClick={handleStop}
                    variant="ghost"
                    className="rounded-full border border-white/10 bg-black/25 px-4 text-white/74 hover:bg-white/8 hover:text-white"
                  >
                    <Square className="mr-2 h-4 w-4 fill-current" />
                    End session
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-[22px] border border-white/10 bg-black/20 p-4">
                  <div className="mb-2 text-[11px] tracking-[0.18em] uppercase text-white/42">
                    Publish URL
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={publishBaseUrl}
                      className="h-11 rounded-2xl border-white/10 bg-white/[0.03] text-white/88"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 rounded-2xl border border-white/10 bg-white/[0.03] text-white/70 hover:bg-white/10 hover:text-white"
                      onClick={() =>
                        void handleCopy(publishBaseUrl, "Publish URL", "publishUrl")
                      }
                    >
                      {renderCopyIcon("publishUrl")}
                    </Button>
                  </div>
                </div>

                <div className="rounded-[22px] border border-white/10 bg-black/20 p-4">
                  <div className="mb-2 text-[11px] tracking-[0.18em] uppercase text-white/42">
                    Stream key
                  </div>
                  <div className="flex items-center gap-2">
                    <StreamKeyField value={hostSession?.snapshot.streamKey ?? ""} />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 rounded-2xl border border-white/10 bg-white/[0.03] text-white/70 hover:bg-white/10 hover:text-white"
                      onClick={() =>
                        void handleCopy(
                          hostSession?.snapshot.streamKey ?? "",
                          "Stream key",
                          "streamKey"
                        )
                      }
                    >
                      {renderCopyIcon("streamKey")}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-start gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  className="rounded-full border border-white/10 bg-black/25 px-4 text-white/72 hover:bg-white/8 hover:text-white"
                  onClick={() => setShowAdvanced((value) => !value)}
                >
                  Advanced
                  {showAdvanced ? (
                    <ChevronLeft className="ml-2 h-4 w-4" />
                  ) : (
                    <ChevronRight className="ml-2 h-4 w-4" />
                  )}
                </Button>

                <div className="min-w-0 flex-1">
                  <AnimatePresence initial={false}>
                    {showAdvanced ? (
                      <motion.div
                        initial={{ opacity: 0, x: -18 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -18 }}
                        transition={{ duration: 0.22, ease: "easeOut" }}
                        className="flex min-w-0 flex-col gap-3 sm:flex-row"
                      >
                        <InlineAdvancedField
                          label="ffmpeg publish"
                          value={ffmpegPublishCommand}
                          onCopy={async () => {
                            await handleCopy(
                              ffmpegPublishCommand,
                              "ffmpeg command",
                              "ffmpegCommand"
                            )
                          }}
                        />
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              </div>

              {status === "paused" ? (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/62">
                  The encoder can keep streaming. Salomon is temporarily ignoring
                  incoming audio for this session until you resume.
                </div>
              ) : null}

              {error ? (
                <div className="rounded-2xl border border-red-400/18 bg-red-500/8 px-4 py-3 text-sm text-red-200/80">
                  {error}
                </div>
              ) : null}
            </div>

            <div className="relative mt-4 flex-1">
              <TranscriberTranscript
                entries={entries}
                error={error}
                isConnected={isConnected}
              />
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
