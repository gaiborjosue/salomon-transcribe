import { Mic, RadioTower } from "lucide-react"

import { Backlight } from "@/components/ui/backlight"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

export type InputSource = "microphone" | "livestream"
export type ChannelLookupState =
  | { status: "idle" }
  | { status: "checking" }
  | {
      status: "live"
      thumbnail?: string
      title: string
      url: string
      videoId: string
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

export function LiveSessionStartPanel({
  channelLookup,
  isMac,
  isSessionActive,
  recordingError,
  selectedSource,
  sourceUrl,
  onCheckChannel,
  onPrimaryAction,
  onSelectedSourceChange,
  onSourceUrlChange,
}: {
  channelLookup: ChannelLookupState
  isMac: boolean
  isSessionActive: boolean
  recordingError: string
  selectedSource: InputSource
  sourceUrl: string
  onCheckChannel: () => void
  onPrimaryAction: () => void
  onSelectedSourceChange: (source: InputSource) => void
  onSourceUrlChange: (url: string) => void
}) {
  return (
    <div className="w-full max-w-2xl px-4">
      <div className="mx-auto flex flex-col gap-7 transition-transform duration-800 ease-[cubic-bezier(0.22,1,0.36,1)]">
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-[2.15rem] font-semibold leading-[0.98] tracking-[-0.04em] text-white/94 sm:text-5xl">
            Start a live session
          </h1>
          <p className="max-w-xl text-sm leading-6 text-white/42 sm:text-[15px]">
            Microphone or YouTube livestream input, with shared session support.
          </p>
        </div>

        <div className="space-y-5">
          <div className="flex justify-center">
            <ToggleGroup
              type="single"
              value={selectedSource}
              onValueChange={(value) => {
                if (value === "microphone" || value === "livestream") {
                  onSelectedSourceChange(value)
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
                onChange={(event) => onSourceUrlChange(event.target.value)}
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
                    onClick={onCheckChannel}
                    disabled={isSessionActive || channelLookup.status === "checking"}
                    className="h-9 rounded-xl px-3 text-white/80 hover:bg-white/6 hover:text-white"
                  >
                    {channelLookup.status === "checking" ? "Checking..." : "Check channel"}
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
                    onClick={() => onSourceUrlChange(channelLookup.url)}
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
                We&apos;ll use your current microphone permission when you start.
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
                  onClick={onPrimaryAction}
                  size="lg"
                  className="relative h-12 w-full rounded-[1.05rem] bg-white text-black shadow-[0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-white/92"
                >
                  {selectedSource === "microphone" ? "Start microphone" : "Start livestream"}
                </Button>
              </div>
            </div>

            <p className="text-xs text-white/34">{isMac ? "⌘K" : "Ctrl+K"} to start or stop</p>

            {recordingError ? (
              <p className="text-center text-sm text-red-400">{recordingError}</p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
