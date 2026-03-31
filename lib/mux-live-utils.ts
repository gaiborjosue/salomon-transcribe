export const MUX_RTMP_PUBLISH_URL = "rtmp://global-live.mux.com:5222/app"
export const MUX_PLAYBACK_BASE_URL = "https://stream.mux.com"

interface PlaybackIdLike {
  id?: string | null
  policy?: string | null
}

interface MuxLiveStreamLike {
  playback_ids?: PlaybackIdLike[] | null
}

export function getPublicMuxPlaybackId(liveStream: MuxLiveStreamLike) {
  return (
    liveStream.playback_ids?.find((item) => item.policy === "public")?.id ?? null
  )
}

export function getMuxPlaybackUrl(playbackId: string | null | undefined) {
  return playbackId ? `${MUX_PLAYBACK_BASE_URL}/${playbackId}.m3u8` : null
}

export function getMuxDashboardUrl(liveStreamId: string) {
  const explicitBase = process.env.MUX_DASHBOARD_BASE_URL?.trim()
  if (explicitBase) {
    return `${explicitBase.replace(/\/+$/u, "")}/video/live-streams/${liveStreamId}/monitor`
  }

  const organizationId = process.env.MUX_DASHBOARD_ORGANIZATION_ID?.trim()
  const environmentId = process.env.MUX_DASHBOARD_ENVIRONMENT_ID?.trim()

  if (organizationId && environmentId) {
    return `https://dashboard.mux.com/organizations/${organizationId}/environments/${environmentId}/video/live-streams/${liveStreamId}/monitor`
  }

  return "https://dashboard.mux.com/video/live-streams"
}
