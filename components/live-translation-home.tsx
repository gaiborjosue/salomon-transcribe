"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Copy, Link2, Mic, RadioTower, Share2, Users } from "lucide-react"
import { toast } from "sonner"

import {
  BackgroundAura,
  BottomControls,
  TranscriberTranscript,
  type TranscriptEntry,
} from "@/components/transcriber-ui"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Backlight } from "@/components/ui/backlight"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useGroqRealtimeTranslation } from "@/hooks/use-groq-realtime-translation"
import { useLivestreamTranslation } from "@/hooks/use-livestream-translation"
import type { LivestreamSessionSnapshot, LivestreamTranscriptEntry } from "@/lib/livestream-types"
import {
  mergeTranscriptEntry,
  shouldMergeIntoPrevious,
} from "@/lib/transcript-text-utils"
import { cn } from "@/lib/utils"
import {
  formatShareCode,
  normalizeShareCode,
  SHARE_CODE_PREFIX,
} from "@/lib/shared-session-manager"

type InputSource = "microphone" | "livestream"
type TranscriptionMode = "conversation" | "sermon"
type MicConnectionState = "idle" | "connecting" | "connected"
type SharedSessionStatus = "active" | "ended"
type ChannelLookupState =
  | { status: "idle" }
  | { status: "checking" }
  | {
      status: "live"
      thumbnail?: string
      title: string
      url: string
      videoId: string
    }

interface SharedSessionSnapshot {
  code: string
  createdAt: number
  entries: TranscriptEntry[]
  id: string
  sourceTitle?: string
  sourceType: InputSource
  status: SharedSessionStatus
  viewerCount: number
}

interface HostShareSession {
  code: string
  hostToken: string
  id: string
  sourceType: InputSource
}

interface ViewerSession {
  code: string
  id: string
  sourceTitle?: string
  sourceType: InputSource
  status: SharedSessionStatus
}

const SOURCE_OPTIONS: Array<{
  icon: typeof Mic
  value: InputSource
  label: string
}> = [
  {
    value: "microphone",
    label: "Live Mic",
    icon: Mic,
  },
  {
    value: "livestream",
    label: "YouTube Live",
    icon: RadioTower,
  },
]

export default function LiveTranslationHome({
  onAccountChromeVisibleChange,
}: {
  onAccountChromeVisibleChange?: (visible: boolean) => void
}) {
  const [selectedSource, setSelectedSource] = useState<InputSource>("microphone")
  const [activeSource, setActiveSource] = useState<InputSource | null>(null)
  const transcriptionMode: TranscriptionMode = "sermon"
  const [sourceUrl, setSourceUrl] = useState("")
  const [channelLookup, setChannelLookup] = useState<ChannelLookupState>({
    status: "idle",
  })
  const [recordingError, setRecordingError] = useState("")
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([])
  const [partialTranscript, setPartialTranscript] = useState("")
  const [sourceTitle, setSourceTitle] = useState("")
  const [isPaused, setIsPaused] = useState(false)
  const [isMac, setIsMac] = useState(true)
  const [micConnectionState, setMicConnectionState] =
    useState<MicConnectionState>("idle")
  const [shareDrawerOpen, setShareDrawerOpen] = useState(false)
  const [joinDrawerOpen, setJoinDrawerOpen] = useState(false)
  const [joinCode, setJoinCode] = useState("")
  const [hostShareSession, setHostShareSession] = useState<HostShareSession | null>(
    null
  )
  const [hostViewerCount, setHostViewerCount] = useState(0)
  const [viewerSession, setViewerSession] = useState<ViewerSession | null>(null)

  const activeSourceRef = useRef<InputSource | null>(null)
  const micConnectionStateRef = useRef<MicConnectionState>("idle")
  const micSessionStartedAtRef = useRef<number | null>(null)
  const micLastTranscriptRef = useRef("")
  const viewerEventSourceRef = useRef<EventSource | null>(null)
  const hostSessionEventsRef = useRef<EventSource | null>(null)
  const transcriptEntriesRef = useRef<TranscriptEntry[]>([])
  const lastHostSyncSignatureRef = useRef("")
  const hasAttemptedClipboardPrefillRef = useRef(false)

  const startSoundRef = useRef<HTMLAudioElement | null>(null)
  const endSoundRef = useRef<HTMLAudioElement | null>(null)
  const errorSoundRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    setIsMac(/(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent))
  }, [])

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

  const updateMicConnectionState = useCallback((next: MicConnectionState) => {
    micConnectionStateRef.current = next
    setMicConnectionState(next)
  }, [])

  const resetTranscript = useCallback(() => {
    setTranscriptEntries([])
    setPartialTranscript("")
    setRecordingError("")
    setSourceTitle("")
    setIsPaused(false)
    micLastTranscriptRef.current = ""
    micSessionStartedAtRef.current = null
  }, [])

  useEffect(() => {
    transcriptEntriesRef.current = transcriptEntries
  }, [transcriptEntries])

  useEffect(() => {
    hostSessionEventsRef.current?.close()
    hostSessionEventsRef.current = null

    if (!hostShareSession) {
      setHostViewerCount(0)
      return
    }

    const eventSource = new EventSource(
      `/api/shared-sessions/${hostShareSession.id}/events?viewer=0`
    )
    hostSessionEventsRef.current = eventSource

    eventSource.addEventListener("snapshot", (event) => {
      const snapshot = JSON.parse(
        (event as MessageEvent<string>).data
      ) as SharedSessionSnapshot
      setHostViewerCount(snapshot.viewerCount)
    })

    eventSource.onerror = () => {
      // Let EventSource retry automatically. No host-facing error needed here.
    }

    return () => {
      eventSource.close()
      if (hostSessionEventsRef.current === eventSource) {
        hostSessionEventsRef.current = null
      }
    }
  }, [hostShareSession])

  const closeViewerStream = useCallback(() => {
    viewerEventSourceRef.current?.close()
    viewerEventSourceRef.current = null
  }, [])

  const clearViewerSession = useCallback(() => {
    closeViewerStream()
    setViewerSession(null)
    setJoinCode("")
    activeSourceRef.current = null
    setActiveSource(null)
    resetTranscript()
  }, [closeViewerStream, resetTranscript])

  const onMicPartialTranscript = useCallback((data: { text?: string }) => {
    if (
      activeSourceRef.current !== "microphone" ||
      micConnectionStateRef.current !== "connected"
    ) {
      return
    }

    const nextText = data.text || ""
    if (nextText === micLastTranscriptRef.current) {
      return
    }

    micLastTranscriptRef.current = nextText
    setPartialTranscript(nextText)
  }, [])

  const onMicFinalTranscript = useCallback(
    (data: { lowConfidence?: boolean; text?: string }) => {
      if (
        activeSourceRef.current !== "microphone" ||
        micConnectionStateRef.current !== "connected"
      ) {
        return
      }

      micLastTranscriptRef.current = ""
      setPartialTranscript("")

      if (!data.text) {
        return
      }

      const finalizedText = data.text.trim()
      if (!finalizedText) {
        return
      }

      const now = Date.now()
      if (micSessionStartedAtRef.current == null) {
        micSessionStartedAtRef.current = now
      }
      const timestampMs = now - micSessionStartedAtRef.current

      setTranscriptEntries((prev) => {
        const previousEntry = prev[prev.length - 1]
        if (shouldMergeIntoPrevious(previousEntry, finalizedText, transcriptionMode)) {
          const mergedEntry = mergeTranscriptEntry(
            previousEntry as TranscriptEntry,
            finalizedText
          )
          return [
            ...prev.slice(0, -1),
            {
              ...mergedEntry,
              lowConfidence:
                Boolean((previousEntry as TranscriptEntry | undefined)?.lowConfidence) ||
                Boolean(data.lowConfidence),
            },
          ]
        }

        return [
          ...prev,
          {
            id: `${now}-${prev.length}`,
            lowConfidence: Boolean(data.lowConfidence),
            text: finalizedText,
            timestampMs,
          },
        ]
      })
    },
    [transcriptionMode]
  )

  const onMicError = useCallback((error: Error | Event) => {
    if (activeSourceRef.current !== "microphone") {
      return
    }

    const message =
      error instanceof Error ? error.message : "Microphone translation failed."
    setRecordingError(message)
    errorSoundRef.current?.play().catch(() => {})
  }, [])

  const groqTranslator = useGroqRealtimeTranslation(
    useMemo(
      () => ({
        onClassifierFallback: () => {
          toast("On-device classifier unavailable. Using server instead.")
        },
        onPartialTranscript: onMicPartialTranscript,
        onFinalTranscript: onMicFinalTranscript,
        onError: onMicError,
      }),
      [onMicError, onMicFinalTranscript, onMicPartialTranscript]
    )
  )

  const livestreamTranslator = useLivestreamTranslation({
    onError: (error) => {
      if (activeSourceRef.current !== "livestream") {
        return
      }

      const message =
        error instanceof Error ? error.message : "Livestream translation failed."
      setRecordingError(message)
      errorSoundRef.current?.play().catch(() => {})
    },
    onFinalTranscript: (entry: LivestreamTranscriptEntry) => {
      if (activeSourceRef.current !== "livestream") {
        return
      }

      setTranscriptEntries((prev) => {
        const previousEntry = prev[prev.length - 1]
        if (shouldMergeIntoPrevious(previousEntry, entry.text, transcriptionMode)) {
          const mergedEntry = mergeTranscriptEntry(
            previousEntry as TranscriptEntry,
            entry.text
          )
          return [
            ...prev.slice(0, -1),
            {
              ...mergedEntry,
              lowConfidence:
                Boolean((previousEntry as TranscriptEntry | undefined)?.lowConfidence) ||
                Boolean(entry.lowConfidence),
            },
          ]
        }

        return [...prev, entry]
      })
    },
    onSnapshot: (snapshot: LivestreamSessionSnapshot) => {
      if (activeSourceRef.current !== "livestream") {
        return
      }

      setTranscriptEntries(snapshot.segments)
      setSourceTitle(snapshot.sourceTitle || "")
      setRecordingError(snapshot.error || "")
      setIsPaused(snapshot.status === "paused")
    },
    onStatusChange: ({ error, sourceTitle: nextSourceTitle, status }) => {
      if (activeSourceRef.current !== "livestream") {
        return
      }

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
    if (activeSource !== "microphone") {
      return
    }

    if (micConnectionState === "connecting" && groqTranslator.status === "error") {
      updateMicConnectionState("idle")
      activeSourceRef.current = null
      setActiveSource(null)
      setIsPaused(false)
      return
    }

    if (micConnectionState === "connected" && groqTranslator.status === "error") {
      updateMicConnectionState("idle")
      activeSourceRef.current = null
      setActiveSource(null)
      setIsPaused(false)
      return
    }

    if (
      micConnectionState === "connected" &&
      groqTranslator.status === "disconnected"
    ) {
      updateMicConnectionState("idle")
      activeSourceRef.current = null
      setActiveSource(null)
      setIsPaused(false)
      return
    }

    setIsPaused(groqTranslator.status === "paused")
  }, [activeSource, groqTranslator.status, micConnectionState, updateMicConnectionState])

  useEffect(() => {
    if (activeSource !== "livestream") {
      return
    }

    if (
      livestreamTranslator.status === "disconnected" ||
      livestreamTranslator.status === "error"
    ) {
      activeSourceRef.current = null
      setActiveSource(null)
      setIsPaused(false)
      return
    }

    setIsPaused(livestreamTranslator.status === "paused")
  }, [activeSource, livestreamTranslator.status])

  const subscribeToSharedSession = useCallback(
    (snapshot: SharedSessionSnapshot) => {
      closeViewerStream()

      const eventSource = new EventSource(
        `/api/shared-sessions/${snapshot.id}/events`
      )
      viewerEventSourceRef.current = eventSource

      setViewerSession({
        code: snapshot.code,
        id: snapshot.id,
        sourceTitle: snapshot.sourceTitle,
        sourceType: snapshot.sourceType,
        status: snapshot.status,
      })
      setSelectedSource(snapshot.sourceType)
      setTranscriptEntries(snapshot.entries)
      setPartialTranscript("")
      setRecordingError("")
      setSourceTitle(snapshot.sourceTitle || "")
      setIsPaused(false)
      activeSourceRef.current = null
      setActiveSource(null)

      eventSource.addEventListener("snapshot", (event) => {
        const nextSnapshot = JSON.parse(
          (event as MessageEvent<string>).data
        ) as SharedSessionSnapshot
        setViewerSession((prev) =>
          prev
            ? {
                ...prev,
                sourceTitle: nextSnapshot.sourceTitle,
                sourceType: nextSnapshot.sourceType,
                status: nextSnapshot.status,
              }
            : {
                code: nextSnapshot.code,
                id: nextSnapshot.id,
                sourceTitle: nextSnapshot.sourceTitle,
                sourceType: nextSnapshot.sourceType,
                status: nextSnapshot.status,
              }
        )
        setTranscriptEntries(nextSnapshot.entries)
        setSourceTitle(nextSnapshot.sourceTitle || "")
      })

      eventSource.addEventListener("entry", (event) => {
        const entry = JSON.parse(
          (event as MessageEvent<string>).data
        ) as TranscriptEntry
        setTranscriptEntries((prev) => [...prev, entry])
      })

      eventSource.addEventListener("meta", (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          sourceTitle?: string
          status: SharedSessionStatus
        }
        setViewerSession((prev) =>
          prev
            ? {
                ...prev,
                sourceTitle: payload.sourceTitle,
                status: payload.status,
              }
            : prev
        )
        if (typeof payload.sourceTitle === "string") {
          setSourceTitle(payload.sourceTitle)
        }
        if (payload.status === "ended") {
          toast("This shared session has ended.")
        }
      })

      eventSource.onerror = () => {
        toast.error("Live share connection was interrupted.")
      }
    },
    [closeViewerStream]
  )

  const handleJoinSharedSession = useCallback(async () => {
    const code = normalizeShareCode(joinCode)
    if (!code) {
      toast.error("Enter a share code.")
      return
    }

    try {
      const response = await fetch("/api/shared-sessions/join", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
      })

      const payload = (await response.json().catch(() => null)) as
        | { error?: string; snapshot?: SharedSessionSnapshot }
        | null

      if (!response.ok || !payload?.snapshot) {
        toast.error(
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to join this session."
        )
        return
      }

      subscribeToSharedSession(payload.snapshot)
      setJoinDrawerOpen(false)
      toast.success(`Joined ${payload.snapshot.code}`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to join this session."
      )
    }
  }, [joinCode, subscribeToSharedSession])

  const handlePasteJoinCode = useCallback(async () => {
    if (!navigator.clipboard?.readText) {
      toast.error("Clipboard paste is not available in this browser.")
      return
    }

    try {
      const clipboardText = await navigator.clipboard.readText()
      const normalized = normalizeShareCode(clipboardText)

      if (!normalized) {
        toast.error(`No ${SHARE_CODE_PREFIX} share code found in clipboard.`)
        return
      }

      setJoinCode(normalized)
    } catch {
      toast.error("Unable to read from clipboard.")
    }
  }, [])

  const ensureHostShareSession = useCallback(async () => {
    if (hostShareSession) {
      return hostShareSession
    }

    const sourceType = activeSourceRef.current
    if (!sourceType) {
      return null
    }

    const response = await fetch("/api/shared-sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourceTitle: sourceTitle || undefined,
        sourceType,
      }),
    })

    const payload = (await response.json().catch(() => null)) as
      | {
          error?: string
          hostToken?: string
          snapshot?: SharedSessionSnapshot
        }
      | null

    if (!response.ok || !payload?.snapshot || !payload.hostToken) {
      throw new Error(
        typeof payload?.error === "string"
          ? payload.error
          : "Unable to create a share code."
      )
    }

    const nextSession: HostShareSession = {
      code: payload.snapshot.code,
      hostToken: payload.hostToken,
      id: payload.snapshot.id,
      sourceType: payload.snapshot.sourceType,
    }

    setHostShareSession(nextSession)
    setHostViewerCount(payload.snapshot.viewerCount)
    lastHostSyncSignatureRef.current = ""
    return nextSession
  }, [hostShareSession, sourceTitle])

  const syncHostSharedSession = useCallback(
    async (entries?: TranscriptEntry[], nextSourceTitle?: string) => {
      const session = hostShareSession
      if (!session) {
        return
      }

      const syncEntries = entries ?? transcriptEntriesRef.current
      const response = await fetch(`/api/shared-sessions/${session.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          entries: syncEntries,
          hostToken: session.hostToken,
          sourceTitle: nextSourceTitle ?? sourceTitle ?? undefined,
          type: "sync",
        }),
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to sync the shared session."
        )
      }
    },
    [hostShareSession, sourceTitle]
  )

  const endHostSharedSession = useCallback(async () => {
    const session = hostShareSession
    if (!session) {
      return
    }

    try {
      await fetch(`/api/shared-sessions/${session.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          hostToken: session.hostToken,
          type: "end",
        }),
      })
    } catch {
      // noop
    } finally {
      setHostShareSession(null)
      setHostViewerCount(0)
      lastHostSyncSignatureRef.current = ""
    }
  }, [hostShareSession])

  const handleOpenShareDrawer = useCallback(async () => {
    try {
      const session = await ensureHostShareSession()
      if (!session) {
        return
      }
      setShareDrawerOpen(true)
      await syncHostSharedSession(transcriptEntriesRef.current, sourceTitle)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to create a share code."
      )
    }
  }, [ensureHostShareSession, sourceTitle, syncHostSharedSession])

  const handleCopyShareCode = useCallback(async () => {
    if (!hostShareSession?.code) {
      return
    }

    try {
      await navigator.clipboard.writeText(hostShareSession.code)
      toast.success("Share code copied.")
    } catch {
      toast.error("Unable to copy the share code.")
    }
  }, [hostShareSession])

  const handleShareCode = useCallback(async () => {
    if (!hostShareSession?.code) {
      return
    }

    const shareText = `Join my live translation session with code ${hostShareSession.code}`

    if (navigator.share) {
      try {
        await navigator.share({
          text: shareText,
          title: "Live Translation session",
        })
        return
      } catch {
        // noop
      }
    }

    try {
      await navigator.clipboard.writeText(hostShareSession.code)
      toast.success("Share code copied.")
    } catch {
      toast.error("Unable to share the code.")
    }
  }, [hostShareSession])

  useEffect(() => {
    return () => {
      closeViewerStream()
      hostSessionEventsRef.current?.close()
      hostSessionEventsRef.current = null
    }
  }, [closeViewerStream])

  useEffect(() => {
    if (!hostShareSession || !activeSourceRef.current) {
      return
    }

    const lastEntry = transcriptEntries[transcriptEntries.length - 1]
    const signature = JSON.stringify({
      count: transcriptEntries.length,
      lastId: lastEntry?.id ?? "",
      lastText: lastEntry?.text ?? "",
      sourceTitle,
    })

    if (lastHostSyncSignatureRef.current === signature) {
      return
    }

    lastHostSyncSignatureRef.current = signature

    void syncHostSharedSession(transcriptEntries, sourceTitle).catch((error) => {
      lastHostSyncSignatureRef.current = ""
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to update the shared session."
      )
    })
  }, [hostShareSession, sourceTitle, syncHostSharedSession, transcriptEntries])

  const currentStatus = useMemo(() => {
    if (viewerSession) {
      return viewerSession.status === "ended" ? "paused" : "connected"
    }

    if (activeSource === "microphone") {
      if (micConnectionState === "connecting") {
        return "connecting"
      }
      if (micConnectionState === "connected") {
        return groqTranslator.status
      }
      return "idle"
    }

    if (activeSource === "livestream") {
      return livestreamTranslator.status
    }

    return "idle"
  }, [
    activeSource,
    groqTranslator.status,
    livestreamTranslator.status,
    micConnectionState,
    viewerSession,
  ])

  const isViewerMode = viewerSession !== null

  const isSessionActive =
    isViewerMode ||
    currentStatus === "connecting" ||
    currentStatus === "connected" ||
    currentStatus === "paused" ||
    currentStatus === "transcribing"

  const hasContent = Boolean(
    recordingError || transcriptEntries.length || partialTranscript
  )

  const stopCurrentSession = useCallback(async () => {
    if (viewerSession) {
      clearViewerSession()
      return
    }

    const currentSource = activeSourceRef.current

    if (currentSource === "microphone") {
      try {
        groqTranslator.disconnect()
        groqTranslator.clearTranscripts()
      } catch {
        // noop
      }
      updateMicConnectionState("idle")
    }

    if (currentSource === "livestream") {
      await livestreamTranslator.disconnect()
    }

    activeSourceRef.current = null
    setActiveSource(null)
    await endHostSharedSession()
    resetTranscript()
    endSoundRef.current?.play().catch(() => {})
  }, [
    clearViewerSession,
    endHostSharedSession,
    groqTranslator,
    livestreamTranslator,
    resetTranscript,
    updateMicConnectionState,
    viewerSession,
  ])

  const handlePrimaryAction = useCallback(async () => {
    if (isSessionActive) {
      await stopCurrentSession()
      return
    }

    closeViewerStream()
    setViewerSession(null)
    setHostShareSession(null)
    lastHostSyncSignatureRef.current = ""
    resetTranscript()

    if (selectedSource === "microphone") {
      activeSourceRef.current = "microphone"
      setActiveSource("microphone")
      updateMicConnectionState("connecting")

      try {
        await groqTranslator.connect({
          classifierMode: "device",
          microphone: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: true,
          },
          transcriptionMode,
        })

        if (activeSourceRef.current !== "microphone") {
          try {
            groqTranslator.disconnect()
          } catch {
            // noop
          }
          return
        }

        micSessionStartedAtRef.current = Date.now()
        updateMicConnectionState("connected")
        startSoundRef.current?.play().catch(() => {})
      } catch {
        activeSourceRef.current = null
        setActiveSource(null)
        updateMicConnectionState("idle")
      }

      return
    }

    const trimmedUrl = sourceUrl.trim()
    if (!trimmedUrl) {
      setRecordingError("Paste a YouTube livestream URL to start.")
      return
    }

    activeSourceRef.current = "livestream"
    setActiveSource("livestream")

    try {
      await livestreamTranslator.connect({
        streamUrl: trimmedUrl,
        transcriptionMode,
      })
      startSoundRef.current?.play().catch(() => {})
    } catch {
      activeSourceRef.current = null
      setActiveSource(null)
    }
  }, [
    groqTranslator,
    isSessionActive,
    livestreamTranslator,
    resetTranscript,
    selectedSource,
    sourceUrl,
    stopCurrentSession,
    transcriptionMode,
    updateMicConnectionState,
    closeViewerStream,
  ])

  const handlePauseToggle = useCallback(async () => {
    if (activeSourceRef.current === "microphone") {
      if (groqTranslator.status === "paused") {
        await groqTranslator.resume()
      } else {
        await groqTranslator.pause()
      }
      return
    }

    if (activeSourceRef.current === "livestream") {
      if (livestreamTranslator.status === "paused") {
        await livestreamTranslator.resume()
      } else {
        await livestreamTranslator.pause()
      }
    }
  }, [groqTranslator, livestreamTranslator])

  const handleCheckChannel = useCallback(async () => {
    setChannelLookup({ status: "checking" })

    try {
      const response = await fetch("/api/youtube-live", {
        method: "GET",
      })
      const payload = (await response.json().catch(() => null)) as
        | {
            error?: string
            live?: boolean
            thumbnail?: string
            title?: string
            url?: string
            videoId?: string
          }
        | null

      if (!response.ok) {
        setChannelLookup({ status: "idle" })
        toast.error(
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to check the channel right now."
        )
        return
      }

      if (!payload?.live || !payload.url || !payload.videoId) {
        setChannelLookup({ status: "idle" })
        toast("No live stream detected right now.")
        return
      }

      setChannelLookup({
        status: "live",
        title: payload.title || "Live now",
        url: payload.url,
        videoId: payload.videoId,
        thumbnail: payload.thumbnail,
      })
    } catch (error) {
      setChannelLookup({ status: "idle" })
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to check the channel right now."
      )
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "k" &&
        (event.metaKey || event.ctrlKey) &&
        event.target instanceof HTMLElement &&
        !["INPUT", "TEXTAREA"].includes(event.target.tagName)
      ) {
        event.preventDefault()
        void handlePrimaryAction()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [handlePrimaryAction])

  const idleSubtitle =
    selectedSource === "microphone"
      ? "Translate your voice to English in real time."
      : "Translate a YouTube livestream to English."

  const statusText = useMemo(() => {
    if (viewerSession) {
      return viewerSession.status === "ended"
        ? "Shared session ended"
        : "Viewing shared session..."
    }

    if (currentStatus === "connecting") {
      return activeSource === "livestream"
        ? "Connecting to livestream..."
        : "Connecting to microphone..."
    }
    if (currentStatus === "paused") {
      return activeSource === "livestream"
        ? "Livestream paused"
        : "Microphone paused"
    }
    if (currentStatus === "transcribing") {
      return activeSource === "livestream"
        ? "Translating livestream..."
        : "Translating microphone..."
    }
    if (currentStatus === "connected") {
      return activeSource === "livestream"
        ? "Listening to livestream..."
        : "Listening to microphone..."
    }

    return "Choose a source to begin"
  }, [activeSource, currentStatus, viewerSession])

  const displaySource = viewerSession?.sourceType ?? activeSource
  const canShareCurrentSession = Boolean(activeSource && !viewerSession)

  useEffect(() => {
    onAccountChromeVisibleChange?.(!(activeSource || viewerSession))
  }, [activeSource, onAccountChromeVisibleChange, viewerSession])

  useEffect(() => {
    if (!joinDrawerOpen) {
      hasAttemptedClipboardPrefillRef.current = false
      return
    }

    if (hasAttemptedClipboardPrefillRef.current || joinCode) {
      return
    }

    hasAttemptedClipboardPrefillRef.current = true

    if (!navigator.clipboard?.readText) {
      return
    }

    void navigator.clipboard
      .readText()
      .then((clipboardText) => {
        const normalized = normalizeShareCode(clipboardText)
        if (normalized) {
          setJoinCode(normalized)
        }
      })
      .catch(() => {
        // Browser permissions vary, especially on mobile. Failing quietly keeps the drawer clean.
      })
  }, [joinCode, joinDrawerOpen])

  return (
    <div className="dark text-foreground min-h-[100dvh] w-full bg-[#1f1f1f]">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-4xl flex-col items-center justify-center px-4 sm:px-8">
        <div className="relative flex min-h-[100dvh] w-full flex-col items-center justify-center gap-8">
          {!isSessionActive ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-6 sm:pb-8">
              <div className="pointer-events-auto">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setJoinDrawerOpen(true)}
                  disabled={isSessionActive}
                  className="h-9 rounded-full border border-white/10 bg-white/[0.03] px-4 text-white/60 hover:bg-white/[0.06] hover:text-white"
                >
                  <Link2 className="h-3.5 w-3.5" />
                  Join with code
                </Button>
              </div>
            </div>
          ) : null}

          <BackgroundAura
            status={currentStatus}
            isConnected={Boolean(isSessionActive)}
          />
          <div className="relative z-10 flex min-h-[350px] w-full flex-1 items-center justify-center overflow-hidden">
            <div
              className={cn(
                "absolute inset-0 transition-[opacity,transform,filter] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]",
                hasContent
                  ? "translate-y-0 opacity-100 blur-0"
                  : "pointer-events-none translate-y-3 opacity-0 blur-[2px]"
              )}
            >
              {hasContent && (
                <>
                  {(displaySource || sourceTitle || hostShareSession || viewerSession) && (
                    <div className="absolute top-4 left-4 right-4 z-20 flex items-start justify-between gap-3">
                      <div className="flex max-w-[min(70vw,34rem)] flex-wrap items-center gap-2 text-xs text-white/50">
                      <span className="rounded-full border border-white/10 px-3 py-1">
                        {displaySource === "microphone"
                          ? "Live Mic"
                          : displaySource === "livestream"
                            ? "YouTube Livestream"
                            : "Shared session"}
                      </span>
                      {displaySource === "livestream" && sourceTitle ? (
                        <div className="rounded-full border border-white/10 px-3 py-1">
                          {sourceTitle}
                        </div>
                      ) : null}
                      {viewerSession ? (
                        <div className="rounded-full border border-white/10 px-3 py-1">
                          Code {viewerSession.code}
                        </div>
                      ) : null}
                      </div>
                      {canShareCurrentSession ? (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => void handleOpenShareDrawer()}
                          className="h-9 rounded-full border border-white/10 bg-white/4 px-3 text-white/70 hover:bg-white/8 hover:text-white"
                        >
                          <Share2 className="h-4 w-4" />
                          <span className="text-sm">
                            {hostShareSession ? hostShareSession.code : "Share"}
                          </span>
                          {hostShareSession ? (
                            <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-white/55">
                              <Users className="h-3 w-3" />
                              {hostViewerCount}
                            </span>
                          ) : null}
                        </Button>
                      ) : null}
                    </div>
                  )}

                  <TranscriberTranscript
                    entries={transcriptEntries}
                    error={recordingError}
                    isConnected={isSessionActive}
                    partialTranscript={
                      activeSource === "microphone" && !viewerSession
                        ? partialTranscript
                        : ""
                    }
                  />
                </>
              )}
            </div>

            <div
              className={cn(
                "absolute inset-0 flex items-center justify-center transition-[opacity,transform,filter] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]",
                !hasContent
                  ? "translate-y-0 opacity-100 blur-0"
                  : "pointer-events-none -translate-y-2 opacity-0 blur-[2px]"
              )}
            >
              {isSessionActive && (
                <p className="text-2xl font-medium tracking-tight text-white/80 transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]">
                  {statusText}
                </p>
              )}
            </div>

            <div
              className={cn(
                "absolute inset-0 flex items-center justify-center transition-[opacity,transform,filter] duration-800 ease-[cubic-bezier(0.22,1,0.36,1)]",
                !isSessionActive
                  ? "translate-y-0 opacity-100 blur-0"
                  : "pointer-events-none -translate-y-5 opacity-0 blur-[3px]"
              )}
            >
              <div className="w-full max-w-2xl px-4">
                <div className="mx-auto flex flex-col gap-7 transition-transform duration-800 ease-[cubic-bezier(0.22,1,0.36,1)]">
                  <div className="flex flex-col items-center gap-3 text-center">
                    <h1 className="text-[2.15rem] font-semibold leading-[0.98] tracking-[-0.04em] text-white/94 sm:text-5xl">
                      Start a live session
                    </h1>
                    <p className="max-w-xl text-sm leading-6 text-white/42 sm:text-[15px]">
                      Microphone or YouTube livestream input, with shared session
                      support.
                    </p>
                  </div>

                  <div className="space-y-5">
                    <div className="flex justify-center">
                      <ToggleGroup
                        type="single"
                        value={selectedSource}
                        onValueChange={(value) => {
                          if (value === "microphone" || value === "livestream") {
                            setSelectedSource(value)
                          }
                        }}
                        variant="outline"
                        className="grid w-full max-w-xl grid-cols-2 gap-1 rounded-[22px] border border-white/10 bg-[#161616] p-1.5"
                        disabled={isSessionActive}
                      >
                        {SOURCE_OPTIONS.map((option) => {
                          const Icon = option.icon
                          return (
                            <ToggleGroupItem
                              key={option.value}
                              value={option.value}
                              className="h-12 rounded-[16px] border-0 bg-transparent text-white/46 shadow-none transition-all hover:text-white data-[state=on]:bg-white data-[state=on]:text-black data-[state=on]:shadow-[0_8px_24px_rgba(255,255,255,0.1)]"
                            >
                              <Icon className="h-4 w-4" />
                              <span>{option.label}</span>
                            </ToggleGroupItem>
                          )
                        })}
                      </ToggleGroup>
                    </div>

                    {selectedSource === "livestream" ? (
                      <div className="mx-auto w-full max-w-xl space-y-3">
                        <Input
                          value={sourceUrl}
                          onChange={(event) => setSourceUrl(event.target.value)}
                          placeholder="Paste YouTube livestream URL"
                          className="h-12 rounded-2xl border-white/10 bg-transparent text-white placeholder:text-white/24"
                          disabled={isSessionActive}
                        />

                        <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm text-white/72">Church channel</p>
                              <p className="truncate text-xs text-white/35">
                                Check whether the channel is live right now.
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => void handleCheckChannel()}
                              disabled={isSessionActive || channelLookup.status === "checking"}
                              className="h-9 rounded-xl px-3 text-white/80 hover:bg-white/6 hover:text-white"
                            >
                              {channelLookup.status === "checking"
                                ? "Checking..."
                                : "Check channel"}
                            </Button>
                          </div>
                        </div>

                        {channelLookup.status === "live" ? (
                          <div className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-200/10 bg-emerald-300/[0.04] px-4 py-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm text-white/78">
                                {channelLookup.title}
                              </p>
                              <p className="text-xs text-emerald-300/72">Live now</p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => setSourceUrl(channelLookup.url)}
                              disabled={isSessionActive}
                              className="h-9 rounded-xl px-3 text-white/80 hover:bg-white/6 hover:text-white"
                            >
                              Use live stream
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="mx-auto w-full max-w-xl rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3">
                        <p className="text-sm text-white/68">
                          We&apos;ll use your current microphone permission when you
                          start.
                        </p>
                      </div>
                    )}

                    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3">
                      <div className="w-full overflow-visible px-2 py-1">
                        <div className="relative h-12 w-full overflow-visible">
                          <Backlight
                            blur={18}
                            className="pointer-events-none absolute inset-0 -z-10 overflow-visible"
                          >
                            <div className="h-12 w-full rounded-[1.05rem] bg-[radial-gradient(circle_at_14%_52%,rgba(132,190,255,0.82),transparent_24%),radial-gradient(circle_at_50%_115%,rgba(112,160,255,0.9),transparent_38%),radial-gradient(circle_at_84%_44%,rgba(143,240,255,0.68),transparent_22%),radial-gradient(circle_at_70%_10%,rgba(255,208,158,0.32),transparent_18%)] p-[1.5px] opacity-95">
                              <div className="h-full w-full rounded-[calc(1.05rem-1.5px)] bg-[#1f1f1f]" />
                            </div>
                          </Backlight>
                          <Button
                            onClick={() => void handlePrimaryAction()}
                            size="lg"
                            className="relative h-12 w-full rounded-[1.05rem] bg-white text-black shadow-[0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-white/92"
                          >
                            {selectedSource === "microphone"
                              ? "Start microphone"
                              : "Start livestream"}
                          </Button>
                        </div>
                      </div>

                      <p className="text-xs text-white/34">
                        {isMac ? "⌘K" : "Ctrl+K"} to start or stop
                      </p>

                      {recordingError ? (
                        <p className="text-center text-sm text-red-400">
                          {recordingError}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {!viewerSession ? (
            <BottomControls
              isConnected={isSessionActive}
              isPaused={isPaused}
              hasError={Boolean(recordingError)}
              isMac={isMac}
              onPauseToggle={() => void handlePauseToggle()}
              onStop={() => void stopCurrentSession()}
            />
          ) : (
            <div className="fixed inset-x-4 bottom-6 z-50 flex items-center justify-center sm:inset-x-auto sm:bottom-8 sm:left-1/2 sm:-translate-x-1/2">
              <div className="bg-background/55 border-border/60 flex w-full max-w-sm items-center gap-2 rounded-2xl border p-2 shadow-lg backdrop-blur-md sm:w-auto">
                <button
                  onClick={() => void stopCurrentSession()}
                  className="bg-foreground text-background border-foreground/10 inline-flex min-h-12 flex-1 items-center justify-center rounded-xl border px-4 py-3 text-sm font-medium transition-opacity hover:opacity-90"
                >
                  Leave session
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <Drawer open={shareDrawerOpen} onOpenChange={setShareDrawerOpen}>
        <DrawerContent className="border-white/10 bg-[#171717] text-white">
          <DrawerHeader className="space-y-2 text-left">
            <DrawerTitle className="text-lg font-semibold tracking-tight text-white">
              Share live session
            </DrawerTitle>
            <DrawerDescription className="text-white/45">
              Anyone with this code can follow the same translated session live.
            </DrawerDescription>
          </DrawerHeader>
          <div className="px-4 pb-2">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4">
              <p className="text-[11px] font-medium tracking-[0.18em] uppercase text-white/35">
                Share code
              </p>
              <div className="mt-2 text-3xl font-semibold tracking-[0.28em] text-white">
                {hostShareSession?.code ?? "......"}
              </div>
              <p className="mt-3 text-sm text-white/45">
                Best for others in the same service to join without processing the
                same audio again.
              </p>
              <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs text-white/55">
                <Users className="h-3.5 w-3.5" />
                {hostViewerCount} joined live
              </div>
            </div>
          </div>
          <DrawerFooter>
            <Button
              type="button"
              onClick={() => void handleCopyShareCode()}
              className="h-12 rounded-xl bg-white text-black hover:bg-white/92"
            >
              <Copy className="h-4 w-4" />
              Copy code
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void handleShareCode()}
              className="h-12 rounded-xl text-white hover:bg-white/6 hover:text-white"
            >
              <Share2 className="h-4 w-4" />
              Share
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      <Drawer open={joinDrawerOpen} onOpenChange={setJoinDrawerOpen}>
        <DrawerContent className="border-white/10 bg-[#171717] text-white">
          <DrawerHeader className="space-y-2 text-left">
            <DrawerTitle className="text-lg font-semibold tracking-tight text-white">
              Join with code
            </DrawerTitle>
            <DrawerDescription className="text-white/45">
              Enter a live session code to follow the same translation feed.
            </DrawerDescription>
          </DrawerHeader>
          <div className="px-4 pb-2">
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel className="text-white/72">Share code</FieldLabel>
                <FieldContent>
                  <Input
                    value={joinCode}
                    onChange={(event) => setJoinCode(formatShareCode(event.target.value))}
                    placeholder={`${SHARE_CODE_PREFIX}-AB12CD`}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    className="h-12 border-white/10 bg-transparent text-center font-medium tracking-[0.24em] text-white placeholder:text-white/22"
                  />
                  <FieldDescription className="text-white/35">
                    Use the code shared by the host. If your browser allows it, we
                    will prefill a copied code automatically.
                  </FieldDescription>
                </FieldContent>
              </Field>
            </FieldGroup>
          </div>
          <DrawerFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void handlePasteJoinCode()}
              className="h-12 rounded-xl text-white hover:bg-white/6 hover:text-white"
            >
              Paste code
            </Button>
            <Button
              type="button"
              onClick={() => void handleJoinSharedSession()}
              className="h-12 rounded-xl bg-white text-black hover:bg-white/92"
            >
              Join session
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  )
}
