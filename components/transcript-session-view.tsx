"use client"

import Link from "next/link"
import { Archive, ArrowLeft, History, Mic, RadioTower, Waves } from "lucide-react"

import {
  BackgroundAura,
  TranscriberTranscript,
} from "@/components/transcriber-ui"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { TranscriptSessionDetail } from "@/lib/transcript-session-types"

function sourceLabel(sourceType: TranscriptSessionDetail["sourceType"]) {
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

function sourceIcon(sourceType: TranscriptSessionDetail["sourceType"]) {
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

function formatEndedAt(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp))
}

export function TranscriptSessionView({
  session,
}: {
  session: TranscriptSessionDetail
}) {
  const SourceIcon = sourceIcon(session.sourceType)

  return (
    <main className="dark text-foreground relative min-h-[100dvh] overflow-hidden bg-[#1f1f1f] text-white">
      <BackgroundAura status="paused" isConnected />

      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-4xl flex-col px-4 py-6 sm:px-8">
        <div className="flex items-center justify-between gap-4">
          <Button
            asChild
            variant="ghost"
            className="rounded-full border border-white/10 bg-black/20 px-4 text-white/70 hover:bg-white/8 hover:text-white"
          >
            <Link href="/">
              <ArrowLeft data-icon="inline-start" />
              Back to live
            </Link>
          </Button>
          <Badge variant="secondary" className="rounded-full border border-white/10 bg-black/25 px-3 py-1 text-[11px] tracking-[0.18em] uppercase text-white/58">
            Saved transcript
          </Badge>
        </div>

        <div className="relative mt-6 flex flex-1 items-center justify-center overflow-hidden">
          <div className="absolute inset-0">
            <div className="absolute top-4 left-4 right-4 z-20 flex items-start justify-between gap-3">
              <div className="flex max-w-[min(72vw,38rem)] flex-wrap items-center gap-2 text-xs text-white/50">
                <span className="rounded-full border border-white/10 px-3 py-1">
                  <SourceIcon className="mr-1.5 inline-block h-3.5 w-3.5 align-[-2px]" />
                  {sourceLabel(session.sourceType)}
                </span>
                {session.sourceTitle ? (
                  <span className="rounded-full border border-white/10 px-3 py-1">
                    {session.sourceTitle}
                  </span>
                ) : null}
                {session.archivedAt ? (
                  <span className="rounded-full border border-white/10 px-3 py-1">
                    <Archive className="mr-1.5 inline-block h-3.5 w-3.5 align-[-2px]" />
                    Archived
                  </span>
                ) : null}
              </div>
              <div className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/50">
                {formatEndedAt(session.endedAt)}
              </div>
            </div>

            <div className="absolute inset-x-0 top-24 z-10 flex justify-center px-4">
              <div className="max-w-2xl text-center">
                <h1 className="text-3xl font-semibold tracking-tight text-white/92">
                  {session.title}
                </h1>
              </div>
            </div>

            <TranscriberTranscript
              entries={session.entries}
              error=""
              isConnected
            />
          </div>
        </div>
      </div>
    </main>
  )
}
