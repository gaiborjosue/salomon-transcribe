"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Info,
  Link2,
  Pause,
  Play,
  RadioTower,
  RefreshCw,
  Square,
} from "lucide-react"
import { AnimatePresence, motion } from "framer-motion"
import { toast } from "sonner"

import {
  BackgroundAura,
  TranscriberTranscript,
  type TranscriptEntry,
} from "@/components/transcriber-ui"
import { Button } from "@/components/ui/button"
import { MultiStepLoader } from "@/components/ui/multi-step-loader"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type {
  MuxLiveStatus,
  MuxProcessingStatus,
  MuxSessionSnapshot,
  MuxSessionSummary,
} from "@/lib/mux-session-types"

interface HostSession {
  hostToken: string
  snapshot: MuxSessionSnapshot
}

interface ResumableSession {
  hostToken: string
  snapshot: MuxSessionSummary
}

const MUX_PAUSED_TOAST_ID = "mux-session-paused"
const MUX_ENDING_STATES = [
  { text: "Pausing the live input" },
  { text: "Removing the Mux live stream" },
  { text: "Closing the Salomon session" },
]

function SensitiveField({
  concealed = false,
  label,
  onCopy,
  value,
}: {
  concealed?: boolean
  label: string
  onCopy: () => Promise<void>
  value: string
}) {
  const [copied, setCopied] = useState(false)
  const [isHovering, setIsHovering] = useState(false)
  const [pointer, setPointer] = useState({ x: 0, y: 0 })

  const handleCopy = useCallback(async () => {
    await onCopy()
    setCopied(true)
    window.setTimeout(() => {
      setCopied(false)
    }, 2200)
  }, [onCopy])

  return (
    <div className="rounded-[22px] border border-white/10 bg-black/20 p-4">
      <div className="mb-2 text-[11px] tracking-[0.18em] uppercase text-white/42">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <div
          className="group relative h-11 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]"
          onMouseEnter={() => {
            if (concealed) {
              setIsHovering(true)
            }
          }}
          onMouseLeave={() => {
            if (concealed) {
              setIsHovering(false)
            }
          }}
          onMouseMove={(event) => {
            if (!concealed) {
              return
            }

            const rect = event.currentTarget.getBoundingClientRect()
            setPointer({
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
            })
          }}
        >
          <div className="absolute inset-0 flex items-center px-3 text-sm tracking-[0.14em] text-white/84">
            {value}
          </div>
          {concealed ? (
            <>
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
            </>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 rounded-2xl border border-white/10 bg-white/[0.03] text-white/70 hover:bg-white/10 hover:text-white"
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
        </Button>
      </div>
    </div>
  )
}

function InfoValueRow({
  label,
  value,
}: {
  label: string
  value: string
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!value) {
      return
    }

    await navigator.clipboard.writeText(value)
    setCopied(true)
    window.setTimeout(() => {
      setCopied(false)
    }, 2200)
  }, [value])

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[10px] tracking-[0.16em] uppercase text-white/42">
          {label}
        </div>
        <div className="mt-1 break-words pr-1 text-[12px] leading-5 text-white/74">
          {value}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 self-center rounded-full border border-white/10 bg-white/[0.03] text-white/60 hover:bg-white/10 hover:text-white"
        onClick={() => {
          void handleCopy()
        }}
        disabled={!value}
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

export function MuxLivePage() {
  const [hostSession, setHostSession] = useState<HostSession | null>(null)
  const [availableSessions, setAvailableSessions] = useState<ResumableSession[]>([])
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [status, setStatus] = useState<MuxProcessingStatus>("disconnected")
  const [muxStatus, setMuxStatus] = useState<MuxLiveStatus>("idle")
  const [error, setError] = useState("")
  const [isCreating, setIsCreating] = useState(false)
  const [isEndingSession, setIsEndingSession] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)

  const closeEvents = useCallback(() => {
    eventSourceRef.current?.close()
    eventSourceRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      closeEvents()
      toast.dismiss(MUX_PAUSED_TOAST_ID)
    }
  }, [closeEvents])

  useEffect(() => {
    if (status === "paused") {
      toast.message("Mux can stay live. Salomon is ignoring audio until you resume.", {
        duration: Infinity,
        id: MUX_PAUSED_TOAST_ID,
      })
      return
    }

    toast.dismiss(MUX_PAUSED_TOAST_ID)
  }, [status])

  const loadAvailableSessions = useCallback(async () => {
    setIsLoadingSessions(true)
    try {
      const response = await fetch("/api/mux/live-streams")
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; sessions?: ResumableSession[] }
        | null

      if (!response.ok || !payload?.sessions) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to load active Mux sessions."
        )
      }

      setAvailableSessions(payload.sessions)
    } catch (nextError) {
      const message =
        nextError instanceof Error
          ? nextError.message
          : "Unable to load active Mux sessions."
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
        `/api/mux/live-streams/${session.snapshot.id}/events?hostToken=${encodeURIComponent(session.hostToken)}`
      )
      eventSourceRef.current = eventSource

      eventSource.addEventListener("snapshot", (event) => {
        const snapshot = JSON.parse(
          (event as MessageEvent<string>).data
        ) as MuxSessionSnapshot
        setHostSession((prev) =>
          prev
            ? {
                ...prev,
                snapshot,
              }
            : {
                hostToken: session.hostToken,
                snapshot,
              }
        )
        setEntries(snapshot.entries)
        setStatus(snapshot.status)
        setMuxStatus(snapshot.muxStatus)
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
          muxStatus?: MuxLiveStatus
          status: MuxProcessingStatus
        }
        setStatus(payload.status)
        if (payload.muxStatus) {
          setMuxStatus(payload.muxStatus)
        }
        setError(payload.error || "")
      })

      eventSource.onerror = () => {
        if (eventSource.readyState === EventSource.CLOSED) {
          toast.error("Mux session connection was interrupted.")
        }
      }
    },
    [closeEvents]
  )

  const handleCreate = useCallback(async () => {
    setIsCreating(true)
    setError("")

    try {
      const response = await fetch("/api/mux/live-streams", {
        method: "POST",
      })

      const payload = (await response.json().catch(() => null)) as
        | { error?: string; hostToken?: string; snapshot?: MuxSessionSnapshot }
        | null

      if (!response.ok || !payload?.hostToken || !payload.snapshot) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to create the Mux live stream."
        )
      }

      const session = {
        hostToken: payload.hostToken,
        snapshot: payload.snapshot,
      }

      setHostSession(session)
      setAvailableSessions((prev) =>
        prev.filter((item) => item.snapshot.id !== payload.snapshot?.id)
      )
      setEntries(payload.snapshot.entries)
      setStatus(payload.snapshot.status)
      setMuxStatus(payload.snapshot.muxStatus)
      subscribe(session)
    } catch (nextError) {
      const message =
        nextError instanceof Error
          ? nextError.message
          : "Unable to create the Mux live stream."
      setError(message)
      toast.error(message)
    } finally {
      setIsCreating(false)
    }
  }, [subscribe])

  const handleResume = useCallback(
    async (sessionToResume: ResumableSession) => {
      try {
        const response = await fetch(
          `/api/mux/live-streams/${sessionToResume.snapshot.id}?hostToken=${encodeURIComponent(sessionToResume.hostToken)}`
        )
        const payload = (await response.json().catch(() => null)) as
          | { error?: string; snapshot?: MuxSessionSnapshot }
          | null

        if (!response.ok || !payload?.snapshot) {
          throw new Error(
            typeof payload?.error === "string"
              ? payload.error
              : "Unable to resume the Mux session."
          )
        }

        const session = {
          hostToken: sessionToResume.hostToken,
          snapshot: payload.snapshot,
        }

        setHostSession(session)
        setEntries(payload.snapshot.entries)
        setStatus(payload.snapshot.status)
        setMuxStatus(payload.snapshot.muxStatus)
        setError(payload.snapshot.error || "")
        subscribe(session)
      } catch (nextError) {
        const message =
          nextError instanceof Error
            ? nextError.message
            : "Unable to resume the Mux session."
        setError(message)
        toast.error(message)
      }
    },
    [subscribe]
  )

  const refreshSession = useCallback(async () => {
    const session = hostSession
    if (!session) {
      return
    }

    setIsRefreshing(true)

    try {
      const response = await fetch(
        `/api/mux/live-streams/${session.snapshot.id}?hostToken=${encodeURIComponent(session.hostToken)}`
      )
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; snapshot?: MuxSessionSnapshot }
        | null

      if (!response.ok || !payload?.snapshot) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to refresh the Mux live stream."
        )
      }

      setHostSession({
        hostToken: session.hostToken,
        snapshot: payload.snapshot,
      })
      setEntries(payload.snapshot.entries)
      setStatus(payload.snapshot.status)
      setMuxStatus(payload.snapshot.muxStatus)
      setError(payload.snapshot.error || "")
    } catch (nextError) {
      const message =
        nextError instanceof Error
          ? nextError.message
          : "Unable to refresh the Mux live stream."
      setError(message)
      toast.error(message)
    } finally {
      setIsRefreshing(false)
    }
  }, [hostSession])

  useEffect(() => {
    if (!hostSession) {
      return
    }

    const handleFocusRefresh = () => {
      void refreshSession()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshSession()
      }
    }

    window.addEventListener("focus", handleFocusRefresh)
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      window.removeEventListener("focus", handleFocusRefresh)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [hostSession, refreshSession])

  const handlePauseToggle = useCallback(async () => {
    const session = hostSession
    if (!session) {
      return
    }

    const action = status === "paused" ? "resume" : "pause"

    try {
      const response = await fetch(`/api/mux/live-streams/${session.snapshot.id}/control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          hostToken: session.hostToken,
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

  const handleStop = useCallback(async () => {
    const session = hostSession
    if (!session) {
      return
    }

    setIsEndingSession(true)

    try {
      const response = await fetch(`/api/mux/live-streams/${session.snapshot.id}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          hostToken: session.hostToken,
        }),
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to end the Mux session."
        )
      }

      closeEvents()
      setHostSession(null)
      await loadAvailableSessions()
      setEntries([])
      setStatus("disconnected")
      setMuxStatus("idle")
      setError("")
      toast.success("Mux live stream removed.")
    } catch (nextError) {
      const message =
        nextError instanceof Error
          ? nextError.message
          : "Unable to end the Mux session."
      setError(message)
      toast.error(message)
    } finally {
      setIsEndingSession(false)
    }
  }, [closeEvents, hostSession, loadAvailableSessions])

  const ffmpegPublishCommand = useMemo(() => {
    if (!hostSession) {
      return ""
    }

    return `ffmpeg -f avfoundation -i ":0" -vn -ac 1 -ar 48000 -c:a aac -b:a 128k -f flv ${hostSession.snapshot.publishUrl}/${hostSession.snapshot.streamKey}`
  }, [hostSession])

  const isActive = Boolean(hostSession)
  const activeSnapshot = hostSession?.snapshot ?? null
  const isDeleted = muxStatus === "deleted"
  const isConnected =
    status === "connected" ||
    status === "connecting" ||
    status === "transcribing" ||
    status === "paused"

  const statusLabel = useMemo(() => {
    if (status === "paused") {
      return "Processing paused"
    }
    if (status === "error") {
      return "Error"
    }
    if (muxStatus === "deleted") {
      return "Live input removed"
    }
    if (muxStatus === "disabled") {
      return "Stream disabled"
    }
    if (muxStatus === "idle") {
      return "Ready to publish"
    }
    if (status === "transcribing") {
      return "Transcribing"
    }
    if (status === "connected") {
      return "Receiving stream"
    }
    return "Connecting to live feed"
  }, [muxStatus, status])

  return (
    <main className="dark text-foreground relative min-h-[100dvh] overflow-hidden bg-[#1f1f1f] text-white">
      <MultiStepLoader
        loading={isEndingSession}
        loadingStates={MUX_ENDING_STATES}
        duration={900}
        loop={false}
      />
      <BackgroundAura status={status} isConnected={isConnected} />

      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-5xl flex-col px-5 py-6 sm:px-8">
        <div className="flex items-center gap-4">
          <div className="flex shrink-0">
            <Button
              asChild
              variant="ghost"
              className={`rounded-full border px-4 transition-all ${
                isDeleted
                  ? "border-cyan-300/30 bg-cyan-300/12 text-cyan-100 shadow-[0_0_0_1px_rgba(165,243,252,0.08),0_0_28px_rgba(34,211,238,0.18)] animate-pulse hover:bg-cyan-300/16 hover:text-white"
                  : "border-white/10 bg-black/20 text-white/70 hover:bg-white/8 hover:text-white"
              }`}
            >
              <Link href="/">Back</Link>
            </Button>
          </div>
          <div className="flex min-w-0 flex-1 justify-center">
            {activeSnapshot?.sharedSessionCode ? (
              <Button
                variant="ghost"
                className="h-10 max-w-full rounded-full border border-white/10 bg-black/20 px-4 text-white/72 hover:bg-white/8 hover:text-white"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(activeSnapshot.sharedSessionCode)
                    .then(() => {
                      toast.success("Share code copied.")
                    })
                    .catch(() => {
                      toast.error("Unable to copy the share code.")
                    })
                }}
              >
                <Link2 className="mr-2 h-4 w-4 shrink-0" />
                <span className="truncate tracking-[0.16em]">
                  {activeSnapshot.sharedSessionCode}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="ml-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-white/45"
                      onClick={(event) => {
                        event.stopPropagation()
                      }}
                    >
                      <Info className="h-3 w-3" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    sideOffset={8}
                    className="max-w-[220px] rounded-2xl border border-white/10 bg-black/88 px-3 py-2 text-xs leading-5 text-white/72 shadow-2xl"
                  >
                    Share this code with members so they can join the live session.
                  </TooltipContent>
                </Tooltip>
              </Button>
            ) : null}
          </div>
          <div className="flex shrink-0">
            <div className="rounded-full border border-white/10 bg-black/25 px-3 py-1.5 text-[11px] tracking-[0.18em] uppercase text-white/50">
              Advanced Mux
            </div>
          </div>
        </div>

        {!isActive ? (
          <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center">
            <div className="w-full space-y-8">
              <div className="space-y-3 text-center">
                <h1 className="text-3xl font-semibold tracking-tight text-white/92 sm:text-4xl">
                  Mux managed ingest
                </h1>
                <p className="mx-auto max-w-xl text-sm leading-6 text-white/48">
                  Create an audio-only live input in Mux, publish to it from your
                  encoder, and let Salomon pull the managed HLS feed only while the
                  stream is active.
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
                        Managed audio-only live
                      </div>
                      <p className="text-sm leading-6 text-white/50">
                        Mux owns the RTMP entrypoint and webhooks signal Salomon when to
                        start or stop pulling the public live HLS feed into the
                        translation pipeline.
                      </p>
                    </div>
                  </div>
                </div>

                <Button
                  onClick={handleCreate}
                  disabled={isCreating}
                  className="h-12 rounded-full bg-white text-black hover:bg-white/92"
                >
                  {isCreating ? "Creating Mux live stream..." : "Create Mux live stream"}
                </Button>
              </div>

              {availableSessions.length > 0 ? (
                <div className="space-y-3 rounded-[28px] border border-white/10 bg-black/20 p-4 sm:p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-sm font-medium text-white/86">
                        Active Mux sessions
                      </div>
                      <p className="text-sm leading-6 text-white/48">
                        Re-enter an ongoing managed session without stopping transcription.
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
                              : sessionItem.snapshot.muxStatus === "active"
                                ? "Live now"
                                : "Ready to publish"}
                          </div>
                          <div className="mt-1 text-xs text-white/46">
                            {sessionItem.snapshot.id}
                          </div>
                          <div className="mt-1 text-xs tracking-[0.14em] text-white/56">
                            {sessionItem.snapshot.sharedSessionCode}
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
                    Mux session
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
                          aria-label="Mux session details"
                        >
                          <Info className="h-4 w-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        sideOffset={10}
                        className="max-w-[320px] rounded-2xl border border-white/10 bg-black/88 px-4 py-3 text-white/72 shadow-2xl"
                      >
                        <div className="space-y-3">
                          <InfoValueRow
                            label="Live stream ID"
                            value={activeSnapshot?.id ?? ""}
                          />
                          {activeSnapshot?.playbackId ? (
                            <InfoValueRow
                              label="Playback ID"
                              value={activeSnapshot.playbackId}
                            />
                          ) : null}
                          <div className="text-[12px] leading-5 text-white/68">
                            <span className="text-white/42">Mux state:</span> {muxStatus}
                          </div>
                          <div className="text-[12px] leading-5 text-white/68">
                            <span className="text-white/42">Audio only:</span>{" "}
                            {activeSnapshot?.audioOnly ? "enabled" : "disabled"}
                          </div>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => void refreshSession()}
                    variant="ghost"
                    disabled={isDeleted || isEndingSession}
                    className="rounded-full border border-white/10 bg-black/25 px-4 text-white/74 hover:bg-white/8 hover:text-white disabled:border-white/6 disabled:bg-black/10 disabled:text-white/30 disabled:hover:bg-black/10"
                  >
                    <RefreshCw
                      className={`mr-2 h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
                    />
                    Refresh status
                  </Button>
                  <Button
                    onClick={handlePauseToggle}
                    variant="ghost"
                    disabled={isDeleted || isEndingSession}
                    className="rounded-full border border-white/10 bg-black/25 px-4 text-white/74 hover:bg-white/8 hover:text-white disabled:border-white/6 disabled:bg-black/10 disabled:text-white/30 disabled:hover:bg-black/10"
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
                    disabled={isDeleted || isEndingSession}
                    className="rounded-full border border-white/10 bg-black/25 px-4 text-white/74 hover:bg-white/8 hover:text-white disabled:border-white/6 disabled:bg-black/10 disabled:text-white/30 disabled:hover:bg-black/10"
                  >
                    <Square className="mr-2 h-4 w-4 fill-current" />
                    End session
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <SensitiveField
                  label="Publish URL"
                  value={activeSnapshot?.publishUrl ?? ""}
                  onCopy={async () => {
                    await navigator.clipboard.writeText(activeSnapshot?.publishUrl ?? "")
                    toast.success("Publish URL copied.")
                  }}
                />
                <SensitiveField
                  label="Stream key"
                  value={activeSnapshot?.streamKey ?? ""}
                  concealed
                  onCopy={async () => {
                    await navigator.clipboard.writeText(activeSnapshot?.streamKey ?? "")
                    toast.success("Stream key copied.")
                  }}
                />
              </div>

              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex flex-1 items-start gap-3">
                  <Button
                    variant="ghost"
                    className="h-10 shrink-0 rounded-full border border-white/10 bg-black/20 px-4 text-white/70 hover:bg-white/8 hover:text-white"
                    onClick={() => setShowAdvanced((value) => !value)}
                  >
                    Advanced
                    {showAdvanced ? (
                      <ChevronLeft className="ml-2 h-4 w-4" />
                    ) : (
                      <ChevronRight className="ml-2 h-4 w-4" />
                    )}
                  </Button>

                  <AnimatePresence initial={false}>
                    {showAdvanced ? (
                      <motion.div
                        key="advanced-inline"
                        initial={{ opacity: 0, width: 0, x: -10 }}
                        animate={{ opacity: 1, width: "100%", x: 0 }}
                        exit={{ opacity: 0, width: 0, x: -10 }}
                        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                        className="min-w-0 flex-1 overflow-hidden"
                      >
                        <div className="flex min-w-0 items-start gap-3">
                          {activeSnapshot?.playbackUrl ? (
                            <InlineAdvancedField
                              label="Playback HLS"
                              value={activeSnapshot.playbackUrl}
                              onCopy={async () => {
                                await navigator.clipboard.writeText(
                                  activeSnapshot.playbackUrl || ""
                                )
                                toast.success("Playback HLS copied.")
                              }}
                            />
                          ) : null}

                          <InlineAdvancedField
                            label="ffmpeg publish"
                            value={ffmpegPublishCommand}
                            onCopy={async () => {
                              await navigator.clipboard.writeText(ffmpegPublishCommand)
                              toast.success("ffmpeg command copied.")
                            }}
                          />
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>

                <Button
                  asChild
                  variant="ghost"
                  className="h-10 shrink-0 rounded-full border border-white/10 bg-black/20 px-4 text-white/70 hover:bg-white/8 hover:text-white"
                >
                  <Link
                    href={activeSnapshot?.dashboardUrl ?? "https://dashboard.mux.com/video/live-streams"}
                    target="_blank"
                  >
                    Open Mux dashboard
                    <ExternalLink className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </div>

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
