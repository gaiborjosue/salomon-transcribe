"use client"

import { useRouter } from "next/navigation"
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { TranscriptHistorySidebar } from "@/components/transcript-history-sidebar"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { getTranscriptSessionPath } from "@/lib/transcript-session-path"
import type {
  TranscriptSessionListPayload,
  TranscriptSessionSummary,
} from "@/lib/transcript-session-types"

const authenticatedShellContext = createContext<AuthenticatedShellCallbacks | null>(null)

function upsertSummary(
  sessions: TranscriptSessionListPayload,
  summary: TranscriptSessionSummary
): TranscriptSessionListPayload {
  const nextActive = sessions.active.filter((session) => session.id !== summary.id)
  const nextArchived = sessions.archived.filter((session) => session.id !== summary.id)

  if (summary.archivedAt) {
    return {
      active: nextActive,
      archived: [summary, ...nextArchived].sort((a, b) => b.updatedAt - a.updatedAt),
    }
  }

  return {
    active: [summary, ...nextActive].sort((a, b) => b.updatedAt - a.updatedAt),
    archived: nextArchived,
  }
}

export function AuthenticatedHomeShell({
  activeHistorySessionId,
  children,
  initialSessions,
  userLabel,
}: {
  activeHistorySessionId?: string | null
  children: React.ReactNode
  initialSessions: TranscriptSessionListPayload
  userLabel: string
}) {
  const router = useRouter()
  const [historySessions, setHistorySessions] = useState(initialSessions)
  const [isLiveSessionActive, setIsLiveSessionActive] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)

  const handleSelectSession = useCallback(
    (session: TranscriptSessionSummary) => {
      if (isLiveSessionActive) {
        toast("Finish the current live session before opening history.")
        return
      }

      router.push(getTranscriptSessionPath(session))
    },
    [isLiveSessionActive, router]
  )

  const handleRenameSession = useCallback(
    async (session: TranscriptSessionSummary, title: string) => {
      try {
        const response = await fetch(`/api/transcript-sessions/${session.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title }),
        })
        const payload = (await response.json().catch(() => null)) as
          | { error?: string; session?: TranscriptSessionSummary }
          | null

        if (!response.ok || !payload?.session) {
          throw new Error(
            typeof payload?.error === "string"
              ? payload.error
              : "Unable to rename the transcript session."
          )
        }

        const updatedSession = payload.session

        setHistorySessions((current) => upsertSummary(current, updatedSession))

        if (activeHistorySessionId === updatedSession.id) {
          router.replace(getTranscriptSessionPath(updatedSession))
        }
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Unable to rename the transcript session."
        )
      }
    },
    [activeHistorySessionId, router]
  )

  const handleArchiveSession = useCallback(async (session: TranscriptSessionSummary, archived: boolean) => {
    try {
      const response = await fetch(`/api/transcript-sessions/${session.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ archived }),
      })
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; session?: TranscriptSessionSummary }
        | null

      if (!response.ok || !payload?.session) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to update the transcript session."
        )
      }

      const updatedSession = payload.session

      setHistorySessions((current) => upsertSummary(current, updatedSession))
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to update the transcript session."
      )
    }
  }, [])

  const handleDeleteSession = useCallback(
    async (session: TranscriptSessionSummary) => {
      try {
        const response = await fetch(`/api/transcript-sessions/${session.id}`, {
          method: "DELETE",
        })
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null

        if (!response.ok) {
          throw new Error(
            typeof payload?.error === "string"
              ? payload.error
              : "Unable to delete the transcript session."
          )
        }

        setHistorySessions((current) => ({
          active: current.active.filter((item) => item.id !== session.id),
          archived: current.archived.filter((item) => item.id !== session.id),
        }))

        if (activeHistorySessionId === session.id) {
          router.replace("/")
        }
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Unable to delete the transcript session."
        )
      }
    },
    [activeHistorySessionId, router]
  )

  const handleTranscriptSaved = useCallback((session: TranscriptSessionSummary) => {
    setHistorySessions((current) => upsertSummary(current, session))
  }, [])

  const callbacks = useMemo<AuthenticatedShellCallbacks>(
    () => ({
      onSessionActivityChange: setIsLiveSessionActive,
      onTranscriptSessionSaved: handleTranscriptSaved,
    }),
    [handleTranscriptSaved]
  )

  useEffect(() => {
    setIsSidebarOpen(!isLiveSessionActive)
  }, [isLiveSessionActive])

  return (
    <authenticatedShellContext.Provider value={callbacks}>
      <SidebarProvider open={isSidebarOpen} onOpenChange={setIsSidebarOpen}>
        <TranscriptHistorySidebar
          disableSelection={isLiveSessionActive}
          selectedSessionId={activeHistorySessionId ?? null}
          sessions={historySessions}
          userLabel={userLabel}
          onArchiveSession={handleArchiveSession}
          onClearSelection={() => router.push("/")}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onSelectSession={handleSelectSession}
        />

        <SidebarInset className="bg-[#1f1f1f]">
          <div
            className="pointer-events-none fixed top-4 z-50 transition-[left] duration-200 ease-linear"
            style={{
              left: isSidebarOpen ? "calc(var(--sidebar-width) + 1rem)" : "1rem",
            }}
          >
            <SidebarTrigger className="pointer-events-auto size-10 rounded-full border border-white/10 bg-black/30 text-white/72 backdrop-blur-sm hover:bg-white/8 hover:text-white" />
          </div>

          <div className="min-h-[100dvh]">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </authenticatedShellContext.Provider>
  )
}

export type AuthenticatedShellCallbacks = {
  onSessionActivityChange: (active: boolean) => void
  onTranscriptSessionSaved: (session: TranscriptSessionSummary) => void
}

export function useAuthenticatedShellCallbacks() {
  const value = useContext(authenticatedShellContext)

  if (!value) {
    throw new Error("useAuthenticatedShellCallbacks must be used within AuthenticatedHomeShell")
  }

  return value
}
