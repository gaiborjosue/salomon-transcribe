"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  Archive,
  ChevronDown,
  CircleUserRound,
  EllipsisVertical,
  History,
  LogOut,
  Mic,
  PanelsTopLeft,
  Plus,
  RadioTower,
  Search,
  Settings,
  Trash2,
  Type,
  Waves,
  X,
} from "lucide-react"
import { toast } from "sonner"

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
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  PopoverCloseButton,
  PopoverContent,
  PopoverLabel,
  PopoverRoot,
  PopoverTrigger,
} from "@/components/ui/cult-popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { GlassSurfaceFilter } from "@/components/ui/glass-surface"
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
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { signOut } from "@/lib/auth-client"
import type {
  TranscriptSessionListPayload,
  TranscriptSessionSummary,
} from "@/lib/transcript-session-types"
import { cn } from "@/lib/utils"

const sessionDateFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  day: "numeric",
})

const footerButtonClass =
  "h-9 min-w-0 justify-between gap-1 rounded-xl border border-sidebar-border/70 bg-sidebar-accent/25 px-2 text-xs text-sidebar-foreground/78 hover:bg-sidebar-accent/86 hover:text-sidebar-foreground"

const advancedLinkClass =
  "h-8 w-full justify-start rounded-lg px-2 text-xs text-sidebar-foreground/80 hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground dark:hover:bg-sidebar-foreground/10"

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
  const [searchOpen, setSearchOpen] = useState(false)
  const searchControlRef = useRef<HTMLDivElement>(null)
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState("")
  const [deleteCandidate, setDeleteCandidate] = useState<TranscriptSessionSummary | null>(
    null
  )
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false)
  const [confirmAccountDeletionOpen, setConfirmAccountDeletionOpen] = useState(false)
  const [isDeletingAccount, setIsDeletingAccount] = useState(false)
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
  const hasArchivedSessions = filteredSessions.archived.length > 0

  function closeSearch() {
    setFilter("")
    setSearchOpen(false)
    searchButtonRef.current?.focus({ preventScroll: true })
  }

  async function handleDeleteAccount() {
    setIsDeletingAccount(true)

    try {
      const response = await fetch("/api/account", {
        method: "DELETE",
      })
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null

      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to delete your account."
        )
      }

      await signOut().catch(() => {})
      setConfirmAccountDeletionOpen(false)
      setAccountSettingsOpen(false)
      router.replace("/sign-up")
      router.refresh()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to delete your account."
      )
    } finally {
      setIsDeletingAccount(false)
    }
  }

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
              const updatedAt = new Date(session.updatedAt)

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
                        className="h-8 border-sidebar-border bg-sidebar-accent text-sidebar-foreground"
                      />
                    </div>
                  ) : (
                    <div className="grid grid-cols-[minmax(0,1fr)_2rem] grid-rows-[1.75rem_auto]">
                      <SidebarMenuButton
                        type="button"
                        size="sm"
                        isActive={selectedSessionId === session.id}
                        onClick={() => onSelectSession(session)}
                        disabled={disableSelection}
                        tooltip={session.title}
                        aria-label={session.title}
                        className="col-span-2 col-start-1 row-span-2 row-start-1 h-auto flex-col items-stretch gap-0 p-0 text-sm"
                      >
                        <span className="h-7 shrink-0 truncate pr-8 pl-2 leading-7">{session.title}</span>
                        <span className="flex items-center justify-between gap-2 px-2 pb-1">
                          <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[10px] [&>svg]:size-2.5">
                            <Icon aria-hidden="true" />
                            {sourceLabel(session.sourceType)}
                          </Badge>
                          <time
                            dateTime={updatedAt.toISOString()}
                            className="truncate text-right text-[11px] font-normal text-sidebar-foreground/65"
                          >
                            {sessionDateFormatter.format(updatedAt)}
                          </time>
                        </span>
                      </SidebarMenuButton>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Manage ${session.title}`}
                            className="z-10 col-start-2 row-start-1 size-7 justify-self-center text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                          >
                            <EllipsisVertical aria-hidden="true" />
                          </Button>
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
                    </div>
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
      <Sidebar
        variant="floating"
        collapsible="offcanvas"
        onEscapeKeyDown={(event) => {
          if (searchOpen && event.target instanceof Node && searchControlRef.current?.contains(event.target)) {
            event.preventDefault()
            closeSearch()
          } else if (advancedOpen) {
            event.preventDefault()
            setAdvancedOpen(false)
          }
        }}
      >
        <SidebarHeader className="flex-row items-center">
          <Button
            type="button"
            onClick={onClearSelection}
            className="h-9 min-w-0 flex-1 justify-start overflow-hidden rounded-xl has-[>svg]:px-2.5"
            aria-label="New transcription"
            title="New transcription"
          >
            <Plus aria-hidden="true" />
            {!searchOpen && <span className="truncate">New transcription</span>}
          </Button>
          <div
            ref={searchControlRef}
            role="search"
            aria-label="Transcript sessions"
            className={cn(
              "relative h-9 min-w-0 flex-none transition-[flex-basis] duration-200 ease-out motion-reduce:transition-none",
              searchOpen ? "basis-[calc(100%_-_2.75rem)]" : "basis-9",
            )}
            onBlur={(event) => {
              if (!filter.trim() && !event.currentTarget.contains(event.relatedTarget)) {
                setFilter("")
                setSearchOpen(false)
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searchOpen && !event.defaultPrevented) {
                event.preventDefault()
                closeSearch()
              }
            }}
          >
            {searchOpen && (
              <SidebarInput
                autoFocus
                type="search"
                aria-label="Search sessions"
                placeholder="Search sessions"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                className="h-9 rounded-full pr-9 [&::-webkit-search-cancel-button]:hidden"
              />
            )}
            <Button
              ref={searchButtonRef}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={searchOpen ? "Close search" : "Search sessions"}
              aria-expanded={searchOpen}
              className={cn(
                "absolute inset-y-0 right-0 rounded-full text-sidebar-foreground/72 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                !searchOpen && "border border-sidebar-border bg-sidebar-accent",
              )}
              onPointerDown={(event) => {
                if (searchOpen) event.preventDefault()
              }}
              onClick={searchOpen ? closeSearch : () => setSearchOpen(true)}
            >
              {searchOpen ? <X aria-hidden="true" /> : <Search aria-hidden="true" />}
            </Button>
          </div>
        </SidebarHeader>

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
                    aria-disabled={!hasArchivedSessions}
                    className="h-9 w-full justify-between px-2 text-sidebar-foreground/72 hover:bg-sidebar-accent/75 hover:text-sidebar-foreground aria-disabled:opacity-60"
                    title="Archived sessions"
                    onClick={(event) => {
                      if (!hasArchivedSessions) {
                        event.preventDefault()
                        event.stopPropagation()
                      }
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <Archive data-icon="inline-start" />
                      <span>Archived</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-[11px] text-sidebar-foreground/65 tabular-nums">
                        {filteredSessions.archived.length}
                      </span>
                      <ChevronDown
                        className={`transition-transform duration-200 ${archivedOpen ? "rotate-180" : ""} ${!hasArchivedSessions ? "opacity-40" : ""}`}
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

        <SidebarFooter className="grid grid-cols-2">
          <PopoverRoot open={advancedOpen} onOpenChange={setAdvancedOpen} className="z-10 min-w-0">
            <PopoverTrigger
              className={cn(
                buttonVariants({ variant: "ghost" }),
                footerButtonClass,
                "glass-surface w-full dark:border-sidebar-border/70 dark:bg-sidebar-accent/25 dark:text-sidebar-foreground/78 dark:hover:bg-sidebar-accent/86",
              )}
            >
              <span className="flex min-w-0 items-center gap-1">
                <PanelsTopLeft aria-hidden="true" className="size-3.5" />
                <span className="truncate">Advanced</span>
              </span>
              <ChevronDown aria-hidden="true" className="size-3 rotate-180" />
              <GlassSurfaceFilter />
            </PopoverTrigger>
            <PopoverContent className="glass-surface bottom-0 left-0 h-auto w-full border-sidebar-border bg-sidebar-accent/95 p-1 pt-9 text-sidebar-foreground shadow-lg dark:bg-sidebar-accent/95">
              <GlassSurfaceFilter />
              <PopoverLabel className="top-0 left-2 flex h-9 items-center gap-1 text-xs font-medium text-sidebar-foreground dark:text-sidebar-foreground">
                <PanelsTopLeft aria-hidden="true" className="size-3.5" />
                Advanced
              </PopoverLabel>
              <Button asChild variant="ghost" className={advancedLinkClass}>
                <Link href="/advanced/rtmp" onNavigate={() => setAdvancedOpen(false)}>
                  <RadioTower aria-hidden="true" />
                  RTMP
                </Link>
              </Button>
              <Button asChild variant="ghost" className={advancedLinkClass}>
                <Link href="/advanced/mux" onNavigate={() => setAdvancedOpen(false)}>
                  <Waves aria-hidden="true" />
                  Mux
                </Link>
              </Button>
              <PopoverCloseButton className="absolute top-1.5 right-1 flex size-6 justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none" />
            </PopoverContent>
          </PopoverRoot>

          <DropdownMenu open={profileOpen} onOpenChange={setProfileOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                glass
                type="button"
                variant="ghost"
                className={footerButtonClass}
                title="Profile"
              >
                <span className="flex min-w-0 items-center gap-1">
                  <CircleUserRound className="size-3.5" />
                  <span className="truncate">Profile</span>
                </span>
                <ChevronDown
                  className={`size-3 transition-transform duration-200 ${profileOpen ? "rotate-0" : "rotate-180"}`}
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
                  onSelect={(event) => {
                    event.preventDefault()
                    setProfileOpen(false)
                    setAccountSettingsOpen(true)
                  }}
                >
                  <Settings />
                  Advanced settings
                </DropdownMenuItem>
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
        </SidebarFooter>
      </Sidebar>

      <AlertDialog
        open={accountSettingsOpen}
        onOpenChange={(open) => {
          if (!open && !isDeletingAccount) {
            setAccountSettingsOpen(false)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Advanced settings</AlertDialogTitle>
            <AlertDialogDescription>
              Manage account-level actions for {userLabel}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Delete account</p>
                <p className="text-sm text-muted-foreground">
                  Permanently remove your account and saved transcript history.
                </p>
              </div>
              <Button
                type="button"
                variant="destructive"
                disabled={isDeletingAccount}
                onClick={() => setConfirmAccountDeletionOpen(true)}
              >
                Delete
              </Button>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingAccount}>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmAccountDeletionOpen}
        onOpenChange={(open) => {
          if (!open && !isDeletingAccount) {
            setConfirmAccountDeletionOpen(false)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your account?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes your Salomon account, active sessions, and saved
              transcript history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingAccount}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeletingAccount}
              onClick={(event) => {
                event.preventDefault()
                void handleDeleteAccount()
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {isDeletingAccount ? "Deleting..." : "Delete account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
