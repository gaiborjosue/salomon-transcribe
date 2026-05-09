"use client"

import dynamic from "next/dynamic"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Copy, Link2, Mic, RadioTower, Share2, Users } from "lucide-react"
import { toast } from "sonner"

import { useAuthenticatedShellCallbacks } from "@/components/auth/authenticated-home-shell"
import { JoinSessionDrawer, ShareSessionDrawer } from "@/components/live-session-drawers"
import { LiveSessionMetaBar } from "@/components/live-session-meta-bar"
import {
  LiveSessionStartPanel,
  type ChannelLookupState,
  type InputSource,
} from "@/components/live-session-start-panel"
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
import { useAudioCues } from "@/hooks/use-audio-cues"
import type {
  LivestreamControllerHandle,
  LivestreamControllerStatus,
  MicrophoneControllerHandle,
  MicControllerStatus,
} from "@/components/live-translation-controller-types"
import type { LivestreamSessionSnapshot, LivestreamTranscriptEntry } from "@/lib/livestream-types"
import type { TranscriptSessionSummary } from "@/lib/transcript-session-types"
import { appendMergedTranscriptEntry } from "@/lib/transcript-entry-merge"
import {
  dedupeBoundaryText,
} from "@/lib/transcript-text-utils"
import { cn } from "@/lib/utils"
import {
  normalizeShareCode,
  SHARE_CODE_PREFIX,
} from "@/lib/share-code-utils"

const LiveTranslationMicrophoneController = dynamic(
  () =>
    import("@/components/live-translation-microphone-controller").then(
      (module) => module.LiveTranslationMicrophoneController
    ),
  { ssr: false }
)

const LiveTranslationLivestreamController = dynamic(
  () =>
    import("@/components/live-translation-livestream-controller").then(
      (module) => module.LiveTranslationLivestreamController
    ),
  { ssr: false }
)

type InputSource = "microphone" | "livestream"
type TranscriptionMode = "conversation" | "sermon"
type MicConnectionState = "idle" | "connecting" | "connected"
type SharedSessionStatus = "active" | "ended"

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

export default function LiveTranslationHome() {
  const { onSessionActivityChange, onTranscriptSessionSaved } =
    useAuthenticatedShellCallbacks()
  const { playEnd, playError, playStart } = useAudioCues()

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
  const [micStatus, setMicStatus] = useState<MicControllerStatus>("idle")
  const [livestreamStatus, setLivestreamStatus] =
    useState<LivestreamControllerStatus>("idle")
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
  const microphoneControllerRef = useRef<MicrophoneControllerHandle | null>(null)
  const livestreamControllerRef = useRef<LivestreamControllerHandle | null>(null)
  const micSessionStartedAtRef = useRef<number | null>(null)
  const activeSessionStartedAtRef = useRef<number | null>(null)
  const micLastTranscriptRef = useRef("")
  const viewerEventSourceRef = useRef<EventSource | null>(null)
  const hostSessionEventsRef = useRef<EventSource | null>(null)
  const transcriptEntriesRef = useRef<TranscriptEntry[]>([])
  const lastHostSyncSignatureRef = useRef("")
  const hasAttemptedClipboardPrefillRef = useRef(false)

  useEffect(() => {
    setIsMac(/(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent))
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
    activeSessionStartedAtRef.current = null
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
        const dedupedText = previousEntry
          ? dedupeBoundaryText(previousEntry.text, finalizedText)
          : finalizedText

        if (!dedupedText) {
          return prev
        }

        return appendMergedTranscriptEntry(
          prev,
          {
            id: `${now}-${prev.length}`,
            lowConfidence: Boolean(data.lowConfidence),
            text: dedupedText,
            timestampMs,
          },
          transcriptionMode
        )
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
    playError()
  }, [playError])

  useEffect(() => {
    if (activeSource !== "microphone") {
      return
    }

    if (micConnectionState === "connecting" && micStatus === "error") {
      updateMicConnectionState("idle")
      activeSourceRef.current = null
      setActiveSource(null)
      setIsPaused(false)
      return
    }

    if (micConnectionState === "connected" && micStatus === "error") {
      updateMicConnectionState("idle")
      activeSourceRef.current = null
      setActiveSource(null)
      setIsPaused(false)
      return
    }

    if (micConnectionState === "connected" && micStatus === "disconnected") {
      updateMicConnectionState("idle")
      activeSourceRef.current = null
      setActiveSource(null)
      setIsPaused(false)
      return
    }

    setIsPaused(micStatus === "paused")
  }, [activeSource, micConnectionState, micStatus, updateMicConnectionState])

  useEffect(() => {
    if (activeSource !== "livestream") {
      return
    }

    if (livestreamStatus === "disconnected" || livestreamStatus === "error") {
      activeSourceRef.current = null
      setActiveSource(null)
      setIsPaused(false)
      return
    }

    setIsPaused(livestreamStatus === "paused")
  }, [activeSource, livestreamStatus])

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
        return micStatus
      }
      return "idle"
    }

    if (activeSource === "livestream") {
      return livestreamStatus
    }

    return "idle"
  }, [activeSource, livestreamStatus, micConnectionState, micStatus, viewerSession])

  const isViewerMode = viewerSession !== null

  const isSessionActive =
    isViewerMode ||
    currentStatus === "connecting" ||
    currentStatus === "connected" ||
    currentStatus === "paused" ||
    currentStatus === "transcribing"

  useEffect(() => {
    onSessionActivityChange?.(isSessionActive)
  }, [isSessionActive, onSessionActivityChange])

  const persistTranscriptSession = useCallback(
    async (sourceType: "livestream" | "microphone" | "mux" | "rtmp") => {
      const entries = transcriptEntriesRef.current
      if (entries.length === 0) {
        return
      }

      const response = await fetch("/api/transcript-sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          endedAt: Date.now(),
          entries,
          sourceTitle: sourceTitle || undefined,
          sourceType,
          startedAt: activeSessionStartedAtRef.current ?? Date.now(),
          title: sourceTitle || undefined,
        }),
      })

      const payload = (await response.json().catch(() => null)) as
        | {
            error?: string
            session?: {
              summary?: TranscriptSessionSummary
            } | null
          }
        | null

      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to save the transcript session."
        )
      }

      if (payload?.session?.summary) {
        onTranscriptSessionSaved?.(payload.session.summary)
      }
    },
    [onTranscriptSessionSaved, sourceTitle]
  )

  const hasContent = Boolean(
    recordingError || transcriptEntries.length || partialTranscript
  )

  const stopCurrentSession = useCallback(async () => {
    if (viewerSession) {
      clearViewerSession()
      return
    }

    const currentSource = activeSourceRef.current

    if (currentSource && transcriptEntriesRef.current.length > 0) {
      try {
        await persistTranscriptSession(currentSource)
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Unable to save the transcript session."
        )
      }
    }

    if (currentSource === "microphone") {
      try {
        microphoneControllerRef.current?.disconnect()
        microphoneControllerRef.current?.clearTranscripts()
      } catch {
        // noop
      }
      updateMicConnectionState("idle")
      setMicStatus("idle")
    }

    if (currentSource === "livestream") {
      await livestreamControllerRef.current?.disconnect()
      setLivestreamStatus("idle")
    }

    activeSourceRef.current = null
    setActiveSource(null)
    await endHostSharedSession()
    resetTranscript()
    playEnd()
  }, [
    clearViewerSession,
    endHostSharedSession,
    playEnd,
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
        await microphoneControllerRef.current?.connect({
          languageCode: "es",
          microphone: {
            echoCancellation: false,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })

        if (activeSourceRef.current !== "microphone") {
          try {
            microphoneControllerRef.current?.disconnect()
          } catch {
            // noop
          }
          return
        }

        micSessionStartedAtRef.current = Date.now()
        activeSessionStartedAtRef.current = Date.now()
        updateMicConnectionState("connected")
        playStart()
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
      await livestreamControllerRef.current?.connect({
        streamUrl: trimmedUrl,
        transcriptionMode,
      })
      activeSessionStartedAtRef.current = Date.now()
      playStart()
    } catch {
      activeSourceRef.current = null
      setActiveSource(null)
    }
  }, [
    isSessionActive,
    playStart,
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
      if (micStatus === "paused") {
        await microphoneControllerRef.current?.resume()
      } else {
        await microphoneControllerRef.current?.pause()
      }
      return
    }

    if (activeSourceRef.current === "livestream") {
      if (livestreamStatus === "paused") {
        await livestreamControllerRef.current?.resume()
      } else {
        await livestreamControllerRef.current?.pause()
      }
    }
  }, [livestreamStatus, micStatus])

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

  const displaySource =
    viewerSession?.sourceType ?? activeSource ?? null
  const canShareCurrentSession = Boolean(activeSource && !viewerSession)

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
      {(selectedSource === "microphone" || activeSource === "microphone") && (
        <LiveTranslationMicrophoneController
          controllerRef={microphoneControllerRef}
          onError={onMicError}
          onFinalTranscript={onMicFinalTranscript}
          onPartialTranscript={onMicPartialTranscript}
          onStatusChange={setMicStatus}
        />
      )}
      {(selectedSource === "livestream" || activeSource === "livestream") && (
        <LiveTranslationLivestreamController
          controllerRef={livestreamControllerRef}
          onError={(error) => {
            if (activeSourceRef.current !== "livestream") {
              return
            }

            const message =
              error instanceof Error ? error.message : "Livestream translation failed."
            setPartialTranscript("")
            setRecordingError(message)
            errorSoundRef.current?.play().catch(() => {})
          }}
          onFinalTranscript={(entry: LivestreamTranscriptEntry) => {
            if (activeSourceRef.current !== "livestream") {
              return
            }

            setPartialTranscript("")
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
          }}
          onPartialTranscript={({ text }) => {
            if (activeSourceRef.current !== "livestream") {
              return
            }

            setPartialTranscript(text?.trim() || "")
          }}
          onSnapshot={(snapshot: LivestreamSessionSnapshot) => {
            if (activeSourceRef.current !== "livestream") {
              return
            }

            setTranscriptEntries(snapshot.segments)
            setPartialTranscript("")
            setSourceTitle(snapshot.sourceTitle || "")
            setRecordingError(snapshot.error || "")
            setIsPaused(snapshot.status === "paused")
          }}
          onStatusChange={({ error, sourceTitle: nextSourceTitle, status }) => {
            setLivestreamStatus(status)

            if (activeSourceRef.current !== "livestream") {
              return
            }

            if (typeof nextSourceTitle === "string") {
              setSourceTitle(nextSourceTitle)
            }
            setIsPaused(status === "paused")
            if (status === "paused" || status === "disconnected" || status === "error") {
              setPartialTranscript("")
            }
            if (error) {
              setRecordingError(error)
            }
          }}
        />
      )}
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
                hasContent && isSessionActive
                  ? "translate-y-0 opacity-100 blur-0"
                  : "pointer-events-none translate-y-3 opacity-0 blur-[2px]"
              )}
            >
              {hasContent && isSessionActive && (
                <>
                  <LiveSessionMetaBar
                    canShare={canShareCurrentSession}
                    displaySource={displaySource}
                    hostCode={hostShareSession?.code}
                    sourceTitle={sourceTitle}
                    viewerCode={viewerSession?.code}
                    viewerCount={hostViewerCount}
                    onShare={() => void handleOpenShareDrawer()}
                  />

                  <TranscriberTranscript
                    activityState={
                      currentStatus === "transcribing"
                        ? "processing"
                        : currentStatus === "connected"
                          ? "listening"
                          : undefined
                    }
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
              <LiveSessionStartPanel
                channelLookup={channelLookup}
                isMac={isMac}
                isSessionActive={isSessionActive}
                recordingError={recordingError}
                selectedSource={selectedSource}
                sourceUrl={sourceUrl}
                onCheckChannel={() => void handleCheckChannel()}
                onPrimaryAction={() => void handlePrimaryAction()}
                onSelectedSourceChange={setSelectedSource}
                onSourceUrlChange={setSourceUrl}
              />
            </div>
          </div>

          {!viewerSession ? (
            <BottomControls
              activityState={
                transcriptEntries.length > 0 &&
                !recordingError &&
                !partialTranscript &&
                (currentStatus === "transcribing" || currentStatus === "connected")
                  ? currentStatus === "transcribing"
                    ? "processing"
                    : "listening"
                  : undefined
              }
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

      <ShareSessionDrawer
        code={hostShareSession?.code}
        open={shareDrawerOpen}
        viewerCount={hostViewerCount}
        onCopyCode={() => void handleCopyShareCode()}
        onOpenChange={setShareDrawerOpen}
        onShareCode={() => void handleShareCode()}
      />

      <JoinSessionDrawer
        code={joinCode}
        open={joinDrawerOpen}
        onCodeChange={setJoinCode}
        onJoin={() => void handleJoinSharedSession()}
        onOpenChange={setJoinDrawerOpen}
        onPasteCode={() => void handlePasteJoinCode()}
      />
    </div>
  )
}
