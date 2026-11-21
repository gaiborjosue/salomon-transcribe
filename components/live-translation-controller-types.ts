import type { LivestreamSessionStatus } from "@/lib/livestream-types"

export type MicControllerStatus = LivestreamSessionStatus
export type LivestreamControllerStatus = LivestreamSessionStatus

export type MicrophoneControllerHandle = {
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  pause: () => void
  resume: () => void
}

export type LivestreamControllerHandle = {
  connect: (streamUrl: string) => Promise<void>
  disconnect: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
}
