export const PORT = Number(process.env.INGEST_PORT || 4100)
export const HOST = process.env.INGEST_HOST?.trim() || "0.0.0.0"
export const RTMP_INPUT_BASE_URL =
  process.env.MEDIAMTX_RTMP_BASE_URL ?? "rtmp://127.0.0.1:1935/live"
export const MAX_CONSECUTIVE_APP_FAILURES = 5
export const RECONNECT_DELAY_MS = 3_000
export const MUX_AUDIO_FILTER =
  process.env.MUX_AUDIO_FILTER?.trim() ||
  "dynaudnorm=f=250:g=9:p=0.9:m=8"
