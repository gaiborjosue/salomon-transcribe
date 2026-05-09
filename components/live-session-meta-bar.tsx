import { Share2, Users } from "lucide-react"

import { Button } from "@/components/ui/button"

function getSourceLabel(source: string | null) {
  if (source === "microphone") {
    return "Live Mic"
  }
  if (source === "livestream") {
    return "YouTube Live"
  }
  if (source === "mux") {
    return "Mux"
  }
  if (source === "rtmp") {
    return "RTMP"
  }
  return "Shared session"
}

export function LiveSessionMetaBar({
  canShare,
  displaySource,
  hostCode,
  sourceTitle,
  viewerCode,
  viewerCount,
  onShare,
}: {
  canShare: boolean
  displaySource: string | null
  hostCode?: string
  sourceTitle: string
  viewerCode?: string
  viewerCount: number
  onShare: () => void
}) {
  if (!displaySource && !sourceTitle && !hostCode && !viewerCode) {
    return null
  }

  return (
    <div className="absolute top-4 left-4 right-4 z-20 flex items-start justify-between gap-3">
      <div className="flex max-w-[min(70vw,34rem)] flex-wrap items-center gap-2 text-xs text-white/50">
        <span className="rounded-full border border-white/10 px-3 py-1">
          {getSourceLabel(displaySource)}
        </span>
        {displaySource === "livestream" && sourceTitle ? (
          <div className="rounded-full border border-white/10 px-3 py-1">
            {sourceTitle}
          </div>
        ) : null}
        {viewerCode ? (
          <div className="rounded-full border border-white/10 px-3 py-1">
            Code {viewerCode}
          </div>
        ) : null}
      </div>
      {canShare ? (
        <Button
          type="button"
          variant="ghost"
          onClick={onShare}
          className="h-9 rounded-full border border-white/10 bg-white/4 px-3 text-white/70 hover:bg-white/8 hover:text-white"
        >
          <Share2 className="h-4 w-4" />
          <span className="text-sm">{hostCode ?? "Share"}</span>
          {hostCode ? (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-white/55">
              <Users className="h-3 w-3" />
              {viewerCount}
            </span>
          ) : null}
        </Button>
      ) : null}
    </div>
  )
}
