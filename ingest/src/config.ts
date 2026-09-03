import { getServerSpeechSegmenterConfig } from "@/lib/server-speech-segmenter"

export const PORT = Number(process.env.INGEST_PORT || 4100)
export const HOST = process.env.INGEST_HOST?.trim() || "0.0.0.0"
export const RTMP_INPUT_BASE_URL =
  process.env.MEDIAMTX_RTMP_BASE_URL ?? "rtmp://127.0.0.1:1935/live"
export const PCM_SAMPLE_RATE = 16000
export const MAX_CHUNK_QUEUE_DURATION_MS = 60_000
export const MAX_CONSECUTIVE_APP_FAILURES = 5
export const RECONNECT_DELAY_MS = 3_000
export const STREAM_SEGMENTER_CONFIG = getServerSpeechSegmenterConfig("sermon")
export const QWEN_REALTIME_URL =
  process.env.DASHSCOPE_REALTIME_URL?.trim() ||
  (process.env.DASHSCOPE_REGION === "cn"
    ? "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    : "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime")
export const QWEN_REALTIME_MODEL =
  process.env.DASHSCOPE_TRANSLATION_MODEL?.trim() ||
  "qwen3-livetranslate-flash-realtime"
export const QWEN_MIC_SESSION_ROTATE_AFTER_MS = Number(
  process.env.QWEN_MIC_SESSION_ROTATE_AFTER_MS ?? String(110 * 60 * 1000)
)
export const QWEN_MIC_UPSTREAM_BUFFER_LIMIT_BYTES = Number(
  process.env.QWEN_MIC_UPSTREAM_BUFFER_LIMIT_BYTES ?? String(3200 * 50)
)
export const QWEN_UPSTREAM_GRACEFUL_CLOSE_TIMEOUT_MS = Number(
  process.env.QWEN_UPSTREAM_GRACEFUL_CLOSE_TIMEOUT_MS ?? "2500"
)
export const MUX_QWEN_AUDIO_FILTER =
  process.env.MUX_QWEN_AUDIO_FILTER?.trim() ||
  "dynaudnorm=f=250:g=9:p=0.9:m=8"
