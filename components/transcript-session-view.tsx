"use client"

import Link from "next/link"
import { Archive, ArrowLeft, History, RadioTower, Waves } from "lucide-react"

import {
  BackgroundAura,
  TranscriberTranscript,
} from "@/components/transcriber-ui"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { TranscriptSessionDetail } from "@/lib/transcript-session-types"

const sourceBadges = {
  livestream: { icon: RadioTower, label: "YouTube Live" },
  mux: { icon: Waves, label: "Mux" },
  rtmp: { icon: History, label: "RTMP" },
}

const endedAtFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
})

export function TranscriptSessionView({
  session,
}: {
  session: TranscriptSessionDetail
}) {
  const source = session.sourceType === "microphone" ? null : sourceBadges[session.sourceType]
  const endedAt = new Date(session.endedAt)

  return (
    <main className="dark text-foreground relative min-h-[100dvh] overflow-hidden bg-app-canvas text-white">
      <BackgroundAura status="paused" isConnected />

      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-4xl flex-col px-4 py-6 sm:px-8">
        <div className="flex items-center justify-between gap-2 sm:gap-4">
          <Button
            glass
            asChild
            variant="ghost"
            className="rounded-full border border-white/10 bg-black/20 px-4 text-white/70 hover:bg-white/8 hover:text-white"
          >
            <Link href="/">
              <ArrowLeft data-icon="inline-start" />
              Back to live
            </Link>
          </Button>
          <Badge asChild variant="secondary" className="rounded-full border border-white/10 bg-black/25 px-2.5 py-1 text-[11px] text-white/58 sm:px-3">
            <time dateTime={endedAt.toISOString()}>{endedAtFormatter.format(endedAt)}</time>
          </Badge>
        </div>

        <div className="relative mt-6 flex flex-1 items-center justify-center overflow-hidden">
          <div className="absolute inset-0">
            {(source || session.sourceTitle || session.archivedAt) ? (
              <div className="absolute top-4 right-4 left-4 z-20 flex max-w-[min(72vw,38rem)] flex-wrap items-center gap-2 text-xs text-white/50">
                {source ? (
                  <span className="rounded-full border border-white/10 px-3 py-1">
                    <source.icon aria-hidden="true" className="mr-1.5 inline-block h-3.5 w-3.5 align-[-2px]" />
                    {source.label}
                  </span>
                ) : null}
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
            ) : null}

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
              textAnimation="none"
            />
          </div>
        </div>
      </div>
    </main>
  )
}
