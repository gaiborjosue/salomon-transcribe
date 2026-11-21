export interface RtmpSessionPayload {
  appBaseUrl: string
  ingestToken: string
  sessionId: string
  streamKey: string
}

export interface MuxSessionPayload {
  appBaseUrl: string
  ingestToken: string
  playbackUrl: string
  sessionId: string
}

export type SessionKind = "mux" | "rtmp"

export type ManagedSession = {
  start: () => void | Promise<void>
  stop: (options?: { notifyApp?: boolean }) => Promise<void>
}

export interface StatusRoutePayload {
  currentStatus?: string
}
