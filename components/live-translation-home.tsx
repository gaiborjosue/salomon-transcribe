"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Copy, Mic, RadioTower, Share2, Users } from "lucide-react"
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
    label: "YouTube Livestream",
    icon: RadioTower,
  },
]

export default function LiveTranslationHome() {
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
    const code = joinCode.trim().toUpperCase()
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

  return (
    <div className="dark text-foreground min-h-screen w-full bg-[#1f1f1f]">
      <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col items-center justify-center px-4 py-10 sm:px-8">
        <div className="relative flex min-h-screen w-full flex-col items-center justify-center gap-8">
          {isSessionActive ? (
            <BackgroundAura
              status={currentStatus}
              isConnected={Boolean(isSessionActive)}
            />
          ) : null}
          <div className="relative z-10 flex min-h-[350px] w-full flex-1 items-center justify-center overflow-hidden">
            <div
              className={cn(
                "absolute inset-0 transition-opacity duration-250",
                hasContent ? "opacity-100" : "pointer-events-none opacity-0"
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
                "absolute inset-0 flex items-center justify-center transition-opacity duration-250",
                !hasContent ? "opacity-100" : "pointer-events-none opacity-0"
              )}
            >
              {isSessionActive && (
                <p className="text-2xl font-medium tracking-tight text-white/80">
                  {statusText}
                </p>
              )}
            </div>

            <div
              className={cn(
                "absolute inset-0 flex items-center justify-center transition-opacity duration-250",
                !isSessionActive ? "opacity-100" : "pointer-events-none opacity-0"
              )}
            >
              <div className="w-full max-w-xl px-4">
                <div className="mx-auto flex flex-col gap-6">
                  <div className="flex flex-col items-center gap-2 text-center">
                    <h1 className="text-3xl font-semibold tracking-tight text-white/92">
                      Live Translation
                    </h1>
                    <p className="text-sm text-white/45">{idleSubtitle}</p>
                  </div>

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
                      className="w-full max-w-md"
                      disabled={isSessionActive}
                    >
                      {SOURCE_OPTIONS.map((option) => {
                        const Icon = option.icon
                        return (
                          <ToggleGroupItem
                            key={option.value}
                            value={option.value}
                            className="flex flex-1 items-center gap-2"
                          >
                            <Icon className="h-4 w-4" />
                            <span>{option.label}</span>
                          </ToggleGroupItem>
                        )
                      })}
                    </ToggleGroup>
                  </div>

                  <div className="space-y-3">
                    {selectedSource === "livestream" ? (
                      <div className="space-y-3">
                        <Input
                          value={sourceUrl}
                          onChange={(event) => setSourceUrl(event.target.value)}
                          placeholder="Paste YouTube livestream URL"
                          className="h-12 border-white/10 bg-transparent text-white placeholder:text-white/28"
                          disabled={isSessionActive}
                        />
                        <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 px-4 py-3">
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
                            className="h-9 rounded-lg px-3 text-white/80 hover:bg-white/6 hover:text-white"
                          >
                            {channelLookup.status === "checking"
                              ? "Checking..."
                              : "Check channel"}
                          </Button>
                        </div>
                        {channelLookup.status === "live" ? (
                          <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 px-4 py-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm text-white/78">
                                {channelLookup.title}
                              </p>
                              <p className="text-xs text-emerald-300/72">
                                Live now
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => setSourceUrl(channelLookup.url)}
                              disabled={isSessionActive}
                              className="h-9 rounded-lg px-3 text-white/80 hover:bg-white/6 hover:text-white"
                            >
                              Use live stream
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex flex-col items-center gap-3">
                    <Button
                      onClick={() => void handlePrimaryAction()}
                      size="lg"
                      className="h-12 min-w-56 rounded-xl bg-white text-black hover:bg-white/92"
                    >
                      {selectedSource === "microphone"
                        ? "Start microphone"
                        : "Start livestream"}
                    </Button>
                    <p className="text-xs text-white/32">
                      {isMac ? "⌘K" : "Ctrl+K"} to start or stop
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setJoinDrawerOpen(true)}
                      disabled={isSessionActive}
                      className="h-9 rounded-full px-4 text-white/58 hover:bg-white/6 hover:text-white"
                    >
                      Join with code
                    </Button>
                    {selectedSource === "microphone" ? (
                      <p className="text-xs text-white/32">
                        Uses your current microphone when you start.
                      </p>
                    ) : null}
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
                    onChange={(event) =>
                      setJoinCode(event.target.value.toUpperCase().replace(/\s+/g, ""))
                    }
                    placeholder="AB12CD"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    className="h-12 border-white/10 bg-transparent text-center font-medium tracking-[0.24em] text-white placeholder:text-white/22"
                  />
                  <FieldDescription className="text-white/35">
                    Use the code shared by the host.
                  </FieldDescription>
                </FieldContent>
              </Field>
            </FieldGroup>
          </div>
          <DrawerFooter>
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
