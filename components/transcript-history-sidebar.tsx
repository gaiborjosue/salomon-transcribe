"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import {
  Archive,
  ChevronDown,
  CircleUserRound,
  History,
  LogOut,
  Mic,
  MoreHorizontal,
  PanelsTopLeft,
  Plus,
  RadioTower,
  Search,
  Trash2,
  Type,
  Waves,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { signOut } from "@/lib/auth-client"
import type {
  TranscriptSessionListPayload,
  TranscriptSessionSummary,
} from "@/lib/transcript-session-types"

function formatRelativeDate(timestamp: number) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  })

  return formatter.format(new Date(timestamp))
}

function sessionIcon(sourceType: TranscriptSessionSummary["sourceType"]) {
  if (sourceType === "microphone") {
    return Mic
  }

  if (sourceType === "livestream") {
    return RadioTower
  }

  if (sourceType === "mux") {
    return Waves
  }

  return History
}

function sourceLabel(sourceType: TranscriptSessionSummary["sourceType"]) {
  if (sourceType === "microphone") {
    return "Live Mic"
  }

  if (sourceType === "livestream") {
    return "YouTube Live"
  }

  if (sourceType === "mux") {
    return "Mux"
  }

  return "RTMP"
}

export function TranscriptHistorySidebar({
  disableSelection,
  selectedSessionId,
  sessions,
  userLabel,
  onArchiveSession,
  onClearSelection,
  onDeleteSession,
  onRenameSession,
  onSelectSession,
}: {
  disableSelection: boolean
  selectedSessionId: string | null
  sessions: TranscriptSessionListPayload
  userLabel: string
  onArchiveSession: (session: TranscriptSessionSummary, archived: boolean) => void
  onClearSelection: () => void
  onDeleteSession: (session: TranscriptSessionSummary) => void
  onRenameSession: (session: TranscriptSessionSummary, title: string) => void
  onSelectSession: (session: TranscriptSessionSummary) => void
}) {
  const router = useRouter()
  const [filter, setFilter] = useState("")
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState("")
  const [deleteCandidate, setDeleteCandidate] = useState<TranscriptSessionSummary | null>(
    null
  )
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)

  const filteredSessions = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) {
      return sessions
    }

    const predicate = (session: TranscriptSessionSummary) =>
      session.title.toLowerCase().includes(needle) ||
      session.previewText?.toLowerCase().includes(needle) ||
      session.sourceTitle?.toLowerCase().includes(needle)

    return {
      active: sessions.active.filter(predicate),
      archived: sessions.archived.filter(predicate),
    }
  }, [filter, sessions])

  useEffect(() => {
    if (
      selectedSessionId &&
      sessions.archived.some((session) => session.id === selectedSessionId)
    ) {
      setArchivedOpen(true)
    }
  }, [selectedSessionId, sessions.archived])

  const renderSessionGroup = (
    groupLabel: string | null,
    items: TranscriptSessionSummary[],
    archived: boolean
  ) => {
    if (items.length === 0) {
      return null
    }

    return (
      <SidebarGroup>
        {groupLabel ? <SidebarGroupLabel>{groupLabel}</SidebarGroupLabel> : null}
        <SidebarGroupContent>
          <SidebarMenu>
            {items.map((session) => {
              const Icon = sessionIcon(session.sourceType)
              const isEditing = editingSessionId === session.id

              return (
                <SidebarMenuItem key={session.id}>
                  {isEditing ? (
                    <div className="flex items-center gap-2 px-2">
                      <Input
                        autoFocus
                        value={draftTitle}
                        onChange={(event) => setDraftTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            const nextTitle = draftTitle.trim()
                            if (nextTitle) {
                              onRenameSession(session, nextTitle)
                            }
                            setEditingSessionId(null)
                          }

                          if (event.key === "Escape") {
                            setEditingSessionId(null)
                          }
                        }}
                        onBlur={() => {
                          const nextTitle = draftTitle.trim()
                          if (nextTitle && nextTitle !== session.title) {
                            onRenameSession(session, nextTitle)
                          }
                          setEditingSessionId(null)
                        }}
                        className="h-8"
                      />
                    </div>
                  ) : (
                    <>
                      <SidebarMenuButton
                        isActive={selectedSessionId === session.id}
                        onClick={() => onSelectSession(session)}
                        disabled={disableSelection}
                        tooltip={session.title}
                      >
                        <Icon />
                        <span>{session.title}</span>
                      </SidebarMenuButton>
                      <SidebarMenuAction asChild showOnHover>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button aria-label={`Manage ${session.title}`}>
                              <MoreHorizontal />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuGroup>
                              <DropdownMenuItem
                                onClick={() => {
                                  setEditingSessionId(session.id)
                                  setDraftTitle(session.title)
                                }}
                              >
                                <Type />
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => onArchiveSession(session, !archived)}
                              >
                                <Archive />
                                {archived ? "Restore" : "Archive"}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDeleteCandidate(session)}
                              >
                                <Trash2 />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SidebarMenuAction>
                      <div className="px-2 pb-2 group-data-[collapsible=icon]:hidden">
                        <div className="flex items-center gap-2 text-[11px] text-sidebar-foreground/45">
                          <Badge variant="secondary" className="rounded-full px-2 py-0 text-[10px]">
                            {sourceLabel(session.sourceType)}
                          </Badge>
                          <span>{formatRelativeDate(session.updatedAt)}</span>
                        </div>
                        {session.previewText ? (
                          <div className="mt-1 line-clamp-2 text-xs leading-5 text-sidebar-foreground/52">
                            {session.previewText}
                          </div>
                        ) : null}
                      </div>
                    </>
                  )}
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    )
  }

  return (
    <>
      <Sidebar variant="floating" collapsible="offcanvas">
        <SidebarHeader>
          <Button
            onClick={onClearSelection}
            className="h-9 justify-start rounded-xl group-data-[collapsible=icon]:size-9 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
            title="New transcription"
          >
            <Plus data-icon="inline-start" />
            <span className="group-data-[collapsible=icon]:hidden">New transcription</span>
          </Button>
          <div className="relative group-data-[collapsible=icon]:hidden">
            <Search className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sidebar-foreground/45" />
            <SidebarInput
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search sessions"
              className="pl-9"
            />
          </div>
        </SidebarHeader>

        <SidebarSeparator />

        <SidebarContent className="overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {renderSessionGroup("Recent", filteredSessions.active, false)}
            </div>

            <div className="pt-2">
              <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen}>
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={filteredSessions.archived.length === 0}
                    className="h-10 w-full justify-between rounded-xl border border-sidebar-border/70 bg-sidebar-accent/25 px-3 text-sidebar-foreground/72 hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-45"
                    title="Archived sessions"
                  >
                    <span className="flex items-center gap-2">
                      <Archive data-icon="inline-start" />
                      <span>Archived</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="rounded-full border border-sidebar-border/70 px-2 py-0.5 text-[11px] text-sidebar-foreground/52">
                        {filteredSessions.archived.length}
                      </span>
                      <ChevronDown
                        className={`transition-transform duration-200 ${archivedOpen ? "rotate-180" : ""}`}
                      />
                    </span>
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
                  <div className="mt-2 max-h-[50%] overflow-y-auto">
                    {renderSessionGroup(null, filteredSessions.archived, true)}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </div>
        </SidebarContent>

        <SidebarSeparator />

        <SidebarFooter>
          <div className="flex flex-col gap-2 rounded-2xl border border-sidebar-border/70 bg-sidebar-accent/25 p-2 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0">
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 w-full justify-between rounded-xl border border-sidebar-border/70 bg-background/20 px-3 text-sidebar-foreground/78 hover:bg-sidebar-accent hover:text-sidebar-foreground group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-sidebar-border/60 group-data-[collapsible=icon]:px-0"
                  title="Advanced"
                >
                  <span className="flex items-center gap-2">
                    <PanelsTopLeft data-icon="inline-start" />
                    <span className="group-data-[collapsible=icon]:hidden">Advanced</span>
                  </span>
                  <ChevronDown
                    className={`transition-transform duration-200 group-data-[collapsible=icon]:hidden ${advancedOpen ? "rotate-180" : ""}`}
                  />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down group-data-[collapsible=icon]:hidden">
                <div className="flex flex-col gap-2 pt-2">
                  <Button
                    asChild
                    variant="ghost"
                    className="h-10 w-full justify-start rounded-xl border border-sidebar-border/60 bg-background/10 px-3 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  >
                    <Link href="/advanced/rtmp">
                      <RadioTower data-icon="inline-start" />
                      RTMP
                    </Link>
                  </Button>
                  <Button
                    asChild
                    variant="ghost"
                    className="h-10 w-full justify-start rounded-xl border border-sidebar-border/60 bg-background/10 px-3 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  >
                    <Link href="/advanced/mux">
                      <Waves data-icon="inline-start" />
                      Mux
                    </Link>
                  </Button>
                </div>
              </CollapsibleContent>
            </Collapsible>

            <DropdownMenu open={profileOpen} onOpenChange={setProfileOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 w-full justify-between rounded-xl border border-sidebar-border/70 bg-background/20 px-3 text-sidebar-foreground/78 hover:bg-sidebar-accent hover:text-sidebar-foreground group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-sidebar-border/60 group-data-[collapsible=icon]:px-0"
                  title="Profile"
                >
                  <span className="flex items-center gap-2">
                    <CircleUserRound data-icon="inline-start" />
                    <span className="group-data-[collapsible=icon]:hidden">Profile</span>
                  </span>
                  <ChevronDown
                    className={`transition-transform duration-200 group-data-[collapsible=icon]:hidden ${profileOpen ? "rotate-0" : "rotate-180"}`}
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="top"
                className="w-64 rounded-xl"
              >
                <DropdownMenuLabel className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-foreground">Profile</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {userLabel}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onClick={() => {
                      void (async () => {
                        setIsSigningOut(true)
                        try {
                          await signOut()
                          router.replace("/sign-in")
                          router.refresh()
                        } finally {
                          setIsSigningOut(false)
                        }
                      })()
                    }}
                    disabled={isSigningOut}
                  >
                    <LogOut />
                    {isSigningOut ? "Signing out..." : "Log out"}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </SidebarFooter>
      </Sidebar>

      <AlertDialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteCandidate(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete transcript session?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the saved transcript and its history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteCandidate) {
                  onDeleteSession(deleteCandidate)
                }
                setDeleteCandidate(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
