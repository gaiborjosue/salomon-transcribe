import "dotenv/config"

import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import type { Readable } from "node:stream"
import WebSocket, { WebSocketServer } from "ws"

import {
  ServerSpeechSegmenter,
  getServerSpeechSegmenterConfig,
} from "@/lib/server-speech-segmenter"
import type { MuxPerfTrace } from "@/lib/mux-session-types"
import type { AudioTranslationMetrics } from "@/lib/process-audio-translation"
import { verifyQwenLiveToken } from "@/lib/qwen-live-token"

const PORT = Number(process.env.INGEST_PORT || 4100)
const RTMP_INPUT_BASE_URL =
  process.env.MEDIAMTX_RTMP_BASE_URL ?? "rtmp://127.0.0.1:1935/live"
const PCM_SAMPLE_RATE = 16000
const MAX_CHUNK_QUEUE_DURATION_MS = 60_000
const MAX_CONSECUTIVE_APP_FAILURES = 5
const RECONNECT_DELAY_MS = 3_000
const STREAM_SEGMENTER_CONFIG = getServerSpeechSegmenterConfig("sermon")
const QWEN_REALTIME_URL =
  process.env.DASHSCOPE_REALTIME_URL?.trim() ||
  (process.env.DASHSCOPE_REGION === "cn"
    ? "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    : "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime")
const QWEN_REALTIME_MODEL =
  process.env.DASHSCOPE_TRANSLATION_MODEL?.trim() ||
  "qwen3-livetranslate-flash-realtime"
const QWEN_MIC_SESSION_ROTATE_AFTER_MS = Number(
  process.env.QWEN_MIC_SESSION_ROTATE_AFTER_MS ?? String(110 * 60 * 1000)
)
const QWEN_MIC_VAD_THRESHOLD = Number(process.env.QWEN_MIC_VAD_THRESHOLD ?? "0.1")
const QWEN_MIC_VAD_SILENCE_MS = Number(
  process.env.QWEN_MIC_VAD_SILENCE_MS ?? "1100"
)
const QWEN_MIC_VAD_PREFIX_PADDING_MS = Number(
  process.env.QWEN_MIC_VAD_PREFIX_PADDING_MS ?? "400"
)
const QWEN_MIC_UPSTREAM_BUFFER_LIMIT_BYTES = Number(
  process.env.QWEN_MIC_UPSTREAM_BUFFER_LIMIT_BYTES ?? String(3200 * 50)
)
const QWEN_UPSTREAM_GRACEFUL_CLOSE_TIMEOUT_MS = Number(
  process.env.QWEN_UPSTREAM_GRACEFUL_CLOSE_TIMEOUT_MS ?? "2500"
)

interface RtmpSessionPayload {
  appBaseUrl: string
  ingestToken: string
  sessionId: string
  streamKey: string
}

interface MuxSessionPayload {
  appBaseUrl: string
  ingestToken: string
  playbackUrl: string
  sessionId: string
}

type SessionKind = "mux" | "rtmp"

class AppControlError extends Error {
  readonly alreadyCounted = true
}

interface QueuedChunk {
  audio: Buffer
  id: string
  queuedAt: number
  segmentDurationMs: number
}

interface ChunkRoutePayload {
  lowConfidence?: boolean
  metrics?: AudioTranslationMetrics
  paused?: boolean
  skipped?: boolean
  text?: string
}

function nextQwenEventId() {
  return `event_${randomUUID().replace(/-/gu, "")}`
}

function extractQwenResponseDoneText(event: Record<string, unknown>) {
  const response =
    event.response && typeof event.response === "object"
      ? (event.response as Record<string, unknown>)
      : null
  const output = Array.isArray(response?.output) ? response.output : []

  for (const outputItem of output) {
    if (!outputItem || typeof outputItem !== "object") {
      continue
    }

    const content = Array.isArray((outputItem as Record<string, unknown>).content)
      ? ((outputItem as Record<string, unknown>).content as unknown[])
      : []

    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") {
        continue
      }

      const contentRecord = contentItem as Record<string, unknown>
      const textValue =
        typeof contentRecord.text === "string"
          ? contentRecord.text
          : typeof contentRecord.transcript === "string"
            ? contentRecord.transcript
            : ""

      const trimmed = textValue.trim()
      if (trimmed) {
        return trimmed
      }
    }
  }

  return ""
}

class MicRealtimeBridge {
  private browserSocket: WebSocket
  private bufferedAudioByteLength = 0
  private bufferedAudioChunks: Buffer[] = []
  private closed = false
  private connectingUpstream = false
  private readonly drainingSockets = new WeakSet<WebSocket>()
  private finalDeliveredForResponse = false
  private partialText = ""
  private paused = false
  private qwenSocket: WebSocket | null = null
  private responseInFlight = false
  private rotateTimer: NodeJS.Timeout | null = null

  constructor(
    browserSocket: WebSocket,
    private readonly config: {
      sourceLanguage: string
      targetLanguage: string
      userId: string
    }
  ) {
    this.browserSocket = browserSocket
  }

  private send(event: Record<string, unknown>) {
    if (this.closed || this.browserSocket.readyState !== WebSocket.OPEN) {
      return
    }
    this.browserSocket.send(JSON.stringify(event))
  }

  private clearRotateTimer() {
    if (this.rotateTimer) {
      clearTimeout(this.rotateTimer)
      this.rotateTimer = null
    }
  }

  private scheduleRotateTimer() {
    this.clearRotateTimer()
    this.rotateTimer = setTimeout(() => {
      void this.rotateUpstream("session-limit")
    }, QWEN_MIC_SESSION_ROTATE_AFTER_MS)
  }

  private bufferAudio(audioBuffer: Buffer) {
    if (audioBuffer.length === 0) {
      return
    }

    this.bufferedAudioChunks.push(audioBuffer)
    this.bufferedAudioByteLength += audioBuffer.length

    while (
      this.bufferedAudioByteLength > QWEN_MIC_UPSTREAM_BUFFER_LIMIT_BYTES &&
      this.bufferedAudioChunks.length > 0
    ) {
      const dropped = this.bufferedAudioChunks.shift()
      this.bufferedAudioByteLength -= dropped?.length ?? 0
    }
  }

  private flushBufferedAudio() {
    if (
      !this.qwenSocket ||
      this.qwenSocket.readyState !== WebSocket.OPEN ||
      this.bufferedAudioChunks.length === 0
    ) {
      return
    }

    for (const audioBuffer of this.bufferedAudioChunks) {
      this.qwenSocket.send(
        JSON.stringify({
          audio: audioBuffer.toString("base64"),
          event_id: nextQwenEventId(),
          type: "input_audio_buffer.append",
        })
      )
    }

    this.bufferedAudioChunks = []
    this.bufferedAudioByteLength = 0
  }

  private async closeUpstreamSocketGracefully(socket: WebSocket | null) {
    if (!socket || this.drainingSockets.has(socket)) {
      return
    }

    this.drainingSockets.add(socket)

    if (socket.readyState !== WebSocket.OPEN) {
      try {
        socket.close()
      } catch {
        // noop
      }
      return
    }

    await new Promise<void>((resolve) => {
      let finished = false
      let closeFallback: NodeJS.Timeout | null = null
      let closeTimeout: NodeJS.Timeout | null = null

      const cleanup = () => {
        socket.off("message", handleMessage)
        socket.off("close", handleClose)
        socket.off("error", handleClose)
        if (closeFallback) {
          clearTimeout(closeFallback)
          closeFallback = null
        }
        if (closeTimeout) {
          clearTimeout(closeTimeout)
          closeTimeout = null
        }
      }

      const done = () => {
        if (finished) {
          return
        }
        finished = true
        cleanup()
        resolve()
      }

      const handleClose = () => {
        done()
      }

      const handleMessage = (rawMessage: WebSocket.RawData) => {
        try {
          const event = JSON.parse(
            typeof rawMessage === "string"
              ? rawMessage
              : rawMessage.toString("utf8")
          ) as Record<string, unknown>

          if (event.type === "session.finished") {
            try {
              socket.close()
            } catch {
              // noop
            }
            closeFallback = setTimeout(() => {
              done()
            }, 250)
          }
        } catch {
          // Ignore malformed shutdown events.
        }
      }

      socket.on("message", handleMessage)
      socket.on("close", handleClose)
      socket.on("error", handleClose)

      socket.send(
        JSON.stringify({
          event_id: nextQwenEventId(),
          type: "session.finish",
        })
      )

      closeTimeout = setTimeout(() => {
        try {
          socket.close()
        } catch {
          // noop
        }
        done()
      }, QWEN_UPSTREAM_GRACEFUL_CLOSE_TIMEOUT_MS)
    })
  }

  private async connectUpstream({ isRotation = false }: { isRotation?: boolean } = {}) {
    const apiKey = process.env.DASHSCOPE_API_KEY?.trim()
    if (!apiKey) {
      throw new Error("DASHSCOPE_API_KEY is not configured.")
    }
    if (this.closed) {
      throw new Error("Mic bridge is closed.")
    }
    if (this.connectingUpstream) {
      return
    }

    this.connectingUpstream = true

    const qwenSocket = new WebSocket(
      `${QWEN_REALTIME_URL}?model=${encodeURIComponent(QWEN_REALTIME_MODEL)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    )
    await new Promise<void>((resolve, reject) => {
      let settled = false

      const fail = (error: Error) => {
        if (settled) {
          return
        }
        settled = true
        this.connectingUpstream = false
        reject(error)
      }

      qwenSocket.on("open", () => {
        qwenSocket.send(
          JSON.stringify({
            event_id: nextQwenEventId(),
            session: {
              input_audio_format: "pcm16",
              input_audio_transcription: {
                language: this.config.sourceLanguage,
              },
              modalities: ["text"],
              turn_detection: {
                prefix_padding_ms: QWEN_MIC_VAD_PREFIX_PADDING_MS,
                silence_duration_ms: QWEN_MIC_VAD_SILENCE_MS,
                threshold: QWEN_MIC_VAD_THRESHOLD,
                type: "server_vad",
              },
              translation: {
                language: this.config.targetLanguage,
              },
            },
            type: "session.update",
          })
        )
      })

      qwenSocket.on("message", (rawMessage) => {
        try {
          const event = JSON.parse(
            typeof rawMessage === "string" ? rawMessage : rawMessage.toString("utf8")
          ) as Record<string, unknown>
          const eventType = typeof event.type === "string" ? event.type : ""
          const isCurrentSocket = this.qwenSocket === qwenSocket

          if (settled && !isCurrentSocket) {
            return
          }

          if (eventType === "error") {
            const message =
              event.error && typeof event.error === "object" && "message" in event.error
                ? String(event.error.message)
                : "Qwen realtime returned an error."
            this.send({ error: message, type: "error" })
            fail(new Error(message))
            return
          }

          if (eventType === "session.updated") {
            this.qwenSocket = qwenSocket
            this.connectingUpstream = false
            this.scheduleRotateTimer()
            this.flushBufferedAudio()
            this.send({ status: "connected", type: "status" })
            if (!settled) {
              settled = true
              resolve()
            }
            return
          }

          if (eventType === "input_audio_buffer.speech_started") {
            this.send({ status: "listening", type: "status" })
            return
          }

          if (eventType === "input_audio_buffer.speech_stopped") {
            this.send({ status: "processing", type: "status" })
            return
          }

          if (eventType === "response.created") {
            this.partialText = ""
            this.finalDeliveredForResponse = false
            this.responseInFlight = true
            return
          }

          if (eventType === "response.text.delta" && typeof event.delta === "string") {
            this.partialText += event.delta
            this.send({
              text: this.partialText,
              type: "partial",
            })
            return
          }

          if (eventType === "response.text.done" && typeof event.text === "string") {
            const text = event.text.trim() || this.partialText.trim()
            if (text && !this.finalDeliveredForResponse) {
              this.finalDeliveredForResponse = true
              this.send({ text, type: "final" })
            }
            this.responseInFlight = false
            this.partialText = ""
            this.send({ status: "connected", type: "status" })
            return
          }

          if (eventType === "response.done") {
            const text = extractQwenResponseDoneText(event) || this.partialText.trim()
            if (text && !this.finalDeliveredForResponse) {
              this.finalDeliveredForResponse = true
              this.send({ text, type: "final" })
            }
            this.responseInFlight = false
            this.partialText = ""
            this.send({ status: "connected", type: "status" })
            return
          }
        } catch (error) {
          fail(
            error instanceof Error
              ? error
              : new Error("Unable to parse Qwen realtime response.")
          )
        }
      })

      qwenSocket.on("error", () => {
        fail(new Error("Qwen realtime connection failed."))
      })

      qwenSocket.on("close", () => {
        const isCurrentSocket = this.qwenSocket === qwenSocket
        const isDraining = this.drainingSockets.has(qwenSocket)

        if (isCurrentSocket) {
          this.qwenSocket = null
        }
        this.connectingUpstream = false
        if (isCurrentSocket) {
          this.clearRotateTimer()
        }
        if (isCurrentSocket && !isDraining) {
          this.responseInFlight = false
          this.send({ status: "disconnected", type: "status" })
        }
        if (!this.closed && settled && isCurrentSocket && !isDraining) {
          void this.rotateUpstream("unexpected-close")
        }
      })
    })
  }

  async start() {
    await this.connectUpstream()
  }

  private async rotateUpstream(reason: "session-limit" | "unexpected-close") {
    if (this.closed || this.connectingUpstream) {
      return
    }

    const previousSocket = this.qwenSocket
    try {
      await this.connectUpstream({ isRotation: true })
      await this.closeUpstreamSocketGracefully(previousSocket)
      if (reason === "session-limit") {
        console.info(
          `[MicRealtime] Rotated upstream Qwen session for user ${this.config.userId} before session limit.`
        )
      }
    } catch (error) {
      console.error(
        `[MicRealtime] Failed to rotate upstream Qwen session for user ${this.config.userId}.`,
        error
      )
      if (!this.closed) {
        this.send({
          error: "Qwen realtime session rotation failed.",
          type: "error",
        })
      }
    }
  }

  handleBrowserMessage(message: WebSocket.RawData, isBinary: boolean) {
    if (!isBinary) {
      try {
        const payload = JSON.parse(String(message)) as {
          action?: "pause" | "resume" | "stop"
          type?: "control"
        }
        if (payload.type === "control") {
          if (payload.action === "pause") {
            this.paused = true
            this.send({ status: "paused", type: "status" })
            return
          }
          if (payload.action === "resume") {
            this.paused = false
            this.send({ status: "connected", type: "status" })
            return
          }
          if (payload.action === "stop") {
            void this.stop()
          }
        }
      } catch {
        // ignore malformed control payloads
      }
      return
    }

    if (this.paused) {
      return
    }

    const audioBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message as ArrayBuffer)
    if (!this.qwenSocket || this.qwenSocket.readyState !== WebSocket.OPEN || this.connectingUpstream) {
      this.bufferAudio(audioBuffer)
      return
    }

    this.qwenSocket.send(
      JSON.stringify({
        audio: audioBuffer.toString("base64"),
        event_id: nextQwenEventId(),
        type: "input_audio_buffer.append",
      })
    )
  }

  async stop() {
    this.closed = true
    this.clearRotateTimer()
    this.bufferedAudioChunks = []
    this.bufferedAudioByteLength = 0

    if (this.qwenSocket && this.qwenSocket.readyState === WebSocket.OPEN) {
      await this.closeUpstreamSocketGracefully(this.qwenSocket)
    } else if (this.qwenSocket) {
      try {
        this.qwenSocket.close()
      } catch {
        // noop
      }
    }
    this.qwenSocket = null

    if (this.browserSocket.readyState === WebSocket.OPEN) {
      this.browserSocket.close()
    }
  }
}

function encodeWav(audioBuffer: Buffer, sampleRate: number) {
  const bytesPerSample = 2
  const blockAlign = bytesPerSample
  const byteRate = sampleRate * blockAlign
  const wavBuffer = Buffer.alloc(44 + audioBuffer.length)

  wavBuffer.write("RIFF", 0)
  wavBuffer.writeUInt32LE(36 + audioBuffer.length, 4)
  wavBuffer.write("WAVE", 8)
  wavBuffer.write("fmt ", 12)
  wavBuffer.writeUInt32LE(16, 16)
  wavBuffer.writeUInt16LE(1, 20)
  wavBuffer.writeUInt16LE(1, 22)
  wavBuffer.writeUInt32LE(sampleRate, 24)
  wavBuffer.writeUInt32LE(byteRate, 28)
  wavBuffer.writeUInt16LE(blockAlign, 32)
  wavBuffer.writeUInt16LE(16, 34)
  wavBuffer.write("data", 36)
  wavBuffer.writeUInt32LE(audioBuffer.length, 40)
  audioBuffer.copy(wavBuffer, 44)

  return wavBuffer
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return null
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

class IngestSession {
  private chunkQueue: QueuedChunk[] = []
  private committedTranslations: string[] = []
  private consecutiveAppFailures = 0
  private ffmpegProcess: ChildProcessByStdio<null, Readable, Readable> | null = null
  private isProcessing = false
  private isAppPaused = false
  private isStopping = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private sawAudio = false
  private readonly speechSegmenter = new ServerSpeechSegmenter(
    this.config.sessionId,
    STREAM_SEGMENTER_CONFIG
  )

  constructor(
    private readonly config: {
      appBaseUrl: string
      chunkPath: string
      ingestToken: string
      inputUrl: string
      kind: SessionKind
      perfPath?: string
      sessionId: string
      statusPath: string
    }
  ) {}

  start() {
    void this.postStatus("connecting")
    this.attachFfmpeg()
  }

  async stop({ notifyApp = true }: { notifyApp?: boolean } = {}) {
    this.isStopping = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.chunkQueue = []
    await this.speechSegmenter.reset()

    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill("SIGTERM")
      this.ffmpegProcess = null
    }

    if (notifyApp) {
      await this.postStatus("disconnected")
    }
  }

  private recordSuccessfulAppContact() {
    this.consecutiveAppFailures = 0
  }

  private async recordAppFailure(message: string) {
    this.consecutiveAppFailures += 1
    if (this.consecutiveAppFailures < MAX_CONSECUTIVE_APP_FAILURES || this.isStopping) {
      return
    }

    console.warn(
      `[${this.config.kind.toUpperCase()} Ingest] Stopping ${this.config.sessionId} after ${this.consecutiveAppFailures} consecutive app failures: ${message}`
    )
    await this.stopFromAppControlPlane(message)
  }

  private async stopFromAppControlPlane(reason: string) {
    if (this.isStopping) {
      return
    }

    console.info(
      `[${this.config.kind.toUpperCase()} Ingest] Stopping ${this.config.sessionId}: ${reason}`
    )
    await stopSession(this.config.kind, this.config.sessionId, { notifyApp: false })
  }

  private async handleAppControlResponse(response: Response, context: string) {
    if (response.ok) {
      this.recordSuccessfulAppContact()
      return false
    }

    if (response.status === 401 || response.status === 404) {
      await this.stopFromAppControlPlane(
        `${context} returned ${response.status}; session is no longer valid in the app`
      )
      return true
    }

    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : `${context} failed with status ${response.status}.`

    await this.recordAppFailure(message)
    throw new AppControlError(message)
  }

  private scheduleReconnect() {
    if (this.isStopping || this.reconnectTimer) {
      return
    }

    void this.postStatus("connecting")
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.attachFfmpeg()
    }, RECONNECT_DELAY_MS)
  }

  private attachFfmpeg() {
    if (this.isStopping) {
      return
    }

    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        this.config.inputUrl,
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        String(PCM_SAMPLE_RATE),
        "-ac",
        "1",
        "-f",
        "s16le",
        "pipe:1",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    )

    this.ffmpegProcess = ffmpeg
    this.sawAudio = false

    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      if (!this.sawAudio) {
        this.sawAudio = true
        void this.postStatus("connected")
      }
      this.handleAudioChunk(chunk)
    })

    ffmpeg.stderr.on("data", () => {
      // Normal startup failures are covered by reconnect handling.
    })

    ffmpeg.on("error", () => {
      this.ffmpegProcess = null
      this.scheduleReconnect()
    })

    ffmpeg.on("close", () => {
      this.ffmpegProcess = null
      this.chunkQueue = []
      void this.speechSegmenter.reset()

      if (this.isStopping) {
        return
      }

      this.scheduleReconnect()
    })
  }

  private handleAudioChunk(chunk: Buffer) {
    void this.handleAudioChunkAsync(chunk)
  }

  private async handleAudioChunkAsync(chunk: Buffer) {
    if (this.isStopping) {
      return
    }

    const nextSegments = await this.speechSegmenter.pushPcm(chunk)
    if (this.isStopping || nextSegments.length === 0) {
      return
    }

    const queuedAt = performance.now()
    this.chunkQueue.push(
      ...nextSegments.map((segment) => ({
        audio: segment,
        id: randomUUID(),
        queuedAt,
        segmentDurationMs: (segment.length / (PCM_SAMPLE_RATE * 2)) * 1000,
      }))
    )
    const maxQueuedChunks = Math.max(
      1,
      Math.ceil(MAX_CHUNK_QUEUE_DURATION_MS / STREAM_SEGMENTER_CONFIG.maxSegmentMs)
    )

    if (this.chunkQueue.length > maxQueuedChunks) {
      const droppedChunkCount = this.chunkQueue.length - maxQueuedChunks
      this.chunkQueue.splice(0, droppedChunkCount)
      console.warn(
        `[${this.config.kind.toUpperCase()} Ingest] Dropped ${droppedChunkCount} queued chunk(s) for ${this.config.sessionId}.`
      )
    }

    void this.processQueue()
  }

  private async processQueue() {
    if (this.isProcessing || this.isStopping || this.chunkQueue.length === 0) {
      return
    }

    const nextChunk = this.chunkQueue.shift()
    if (!nextChunk) {
      return
    }

    this.isProcessing = true
    const processStartedAt = performance.now()

    try {
      if (!this.isAppPaused) {
        await this.postStatus("transcribing")
      }

      const wavEncodeStartedAt = performance.now()
      const wavBuffer = encodeWav(nextChunk.audio, PCM_SAMPLE_RATE)
      const wavEncodeMs = performance.now() - wavEncodeStartedAt
      const formData = new FormData()
      formData.append(
        "audio",
        new File([wavBuffer], `${this.config.kind}-segment.wav`, { type: "audio/wav" })
      )

      const context = this.committedTranslations.slice(-2).join(" ").trim()
      if (context) {
        formData.append("context", context)
      }

      const fetchStartedAt = performance.now()
      const response = await fetch(new URL(this.config.chunkPath, this.config.appBaseUrl), {
        method: "POST",
        headers: {
          "x-salomon-ingest-token": this.config.ingestToken,
        },
        body: formData,
      })
      const fetchRoundTripMs = performance.now() - fetchStartedAt

      if (await this.handleAppControlResponse(response, "Chunk upload")) {
        return
      }

      const payload = (await response.json().catch(() => null)) as
        | ChunkRoutePayload
        | null
      this.recordSuccessfulAppContact()

      this.isAppPaused = payload?.paused === true

      if (this.config.kind === "mux" && !this.isAppPaused) {
        void this.postPerf({
          cfRay: payload?.metrics?.cfRay,
          classifierDecision: payload?.metrics?.decision,
          contextChars: payload?.metrics?.contextChars,
          contextTruncated: payload?.metrics?.contextTruncated,
          fetchRoundTripMs,
          groqMs: payload?.metrics?.groqMs,
          id: nextChunk.id,
          lowConfidence: payload?.lowConfidence,
          musicScore: payload?.metrics?.musicScore,
          networkOverheadMs:
            typeof payload?.metrics?.totalMs === "number"
              ? Math.max(0, fetchRoundTripMs - payload.metrics.totalMs)
              : undefined,
          promptChars: payload?.metrics?.promptChars,
          queueWaitMs: processStartedAt - nextChunk.queuedAt,
          responseSkipped: payload?.skipped === true,
          segmentDurationMs: nextChunk.segmentDurationMs,
          serverClassifierMs: payload?.metrics?.classifierMs,
          serverTotalMs: payload?.metrics?.totalMs,
          source: "mux-hls",
          speechScore: payload?.metrics?.speechScore,
          status: payload?.skipped ? "skipped" : "completed",
          textLength: payload?.text?.trim().length || 0,
          topLabel: payload?.metrics?.topLabel,
          wavEncodeMs,
          workerTotalMs: performance.now() - nextChunk.queuedAt,
          xGroqRegion: payload?.metrics?.xGroqRegion,
        })
      }

      if (!payload?.skipped && typeof payload?.text === "string" && payload.text.trim()) {
        this.committedTranslations = [...this.committedTranslations, payload.text.trim()].slice(
          -2
        )
      }

      if (this.isAppPaused) {
        await this.postStatus("paused")
      } else {
        await this.postStatus("connected")
      }
    } catch (error) {
      if (!(error instanceof AppControlError)) {
        if (this.config.kind === "mux") {
          void this.postPerf({
            fetchRoundTripMs: undefined,
            id: nextChunk.id,
            responseSkipped: false,
            segmentDurationMs: nextChunk.segmentDurationMs,
            source: "mux-hls",
            status: "failed",
            wavEncodeMs: undefined,
            workerTotalMs: performance.now() - nextChunk.queuedAt,
          })
        }
        await this.recordAppFailure(
          error instanceof Error
            ? error.message
            : `${this.config.kind.toUpperCase()} chunk processing failed.`
        )
      }

      if (this.isStopping) {
        return
      }

      await this.postStatus(
        "error",
        error instanceof Error
          ? error.message
          : `${this.config.kind.toUpperCase()} chunk processing failed.`
      )
    } finally {
      this.isProcessing = false
    }

    if (this.chunkQueue.length > 0 && !this.isStopping) {
      void this.processQueue()
    }
  }

  private async postStatus(status: string, error?: string) {
    try {
      const response = await fetch(new URL(this.config.statusPath, this.config.appBaseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-salomon-ingest-token": this.config.ingestToken,
        },
        body: JSON.stringify({ error, status }),
      })

      await this.handleAppControlResponse(response, "Status update")
    } catch (error) {
      if (error instanceof AppControlError) {
        return
      }

      await this.recordAppFailure(
        error instanceof Error
          ? error.message
          : `Unable to post ${status} status to the app.`
      )
    }
  }

  private async postPerf(perf: MuxPerfTrace) {
    if (!this.config.perfPath) {
      return
    }

    try {
      const response = await fetch(new URL(this.config.perfPath, this.config.appBaseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-salomon-ingest-token": this.config.ingestToken,
        },
        body: JSON.stringify({ perf }),
      })

      await this.handleAppControlResponse(response, "Perf event")
    } catch (error) {
      if (error instanceof AppControlError) {
        return
      }

      await this.recordAppFailure(
        error instanceof Error
          ? error.message
          : `${this.config.kind.toUpperCase()} perf event failed.`
      )
    }
  }
}

const sessions = new Map<string, IngestSession>()

function getSessionMapKey(kind: SessionKind, sessionId: string) {
  return `${kind}:${sessionId}`
}

async function createOrReplaceSession(
  kind: SessionKind,
  sessionId: string,
  session: IngestSession
) {
  const key = getSessionMapKey(kind, sessionId)
  const previous = sessions.get(key)
  if (previous) {
    await previous.stop()
    sessions.delete(key)
  }

  sessions.set(key, session)
  session.start()
}

async function stopSession(
  kind: SessionKind,
  sessionId: string,
  options?: { notifyApp?: boolean }
) {
  const key = getSessionMapKey(kind, sessionId)
  const session = sessions.get(key)

  if (!session) {
    return false
  }

  await session.stop(options)
  sessions.delete(key)
  return true
}

const server = createServer(async (incomingRequest, outgoingResponse) => {
  const method = incomingRequest.method || "GET"
  const url = new URL(incomingRequest.url || "/", `http://127.0.0.1:${PORT}`)

  if (method === "GET" && url.pathname === "/health") {
    outgoingResponse.writeHead(200, { "Content-Type": "application/json" })
    outgoingResponse.end(JSON.stringify({ ok: true }))
    return
  }

  if (method === "POST" && url.pathname === "/sessions") {
    const body = (await readJsonBody(incomingRequest)) as Partial<RtmpSessionPayload> | null

    if (
      !body?.appBaseUrl ||
      !body?.ingestToken ||
      !body?.sessionId ||
      !body?.streamKey
    ) {
      outgoingResponse.writeHead(400, { "Content-Type": "application/json" })
      outgoingResponse.end(JSON.stringify({ error: "Invalid RTMP session payload." }))
      return
    }

    const inputUrl = `${RTMP_INPUT_BASE_URL.replace(/\/+$/u, "")}/${body.streamKey}`
    const session = new IngestSession({
      appBaseUrl: body.appBaseUrl,
      chunkPath: `/api/rtmp-sessions/${body.sessionId}/chunk`,
      ingestToken: body.ingestToken,
      inputUrl,
      kind: "rtmp",
      perfPath: undefined,
      sessionId: body.sessionId,
      statusPath: `/api/rtmp-sessions/${body.sessionId}/status`,
    })

    await createOrReplaceSession("rtmp", body.sessionId, session)

    outgoingResponse.writeHead(200, { "Content-Type": "application/json" })
    outgoingResponse.end(JSON.stringify({ ok: true }))
    return
  }

  if (method === "POST" && url.pathname === "/mux-sessions") {
    const body = (await readJsonBody(incomingRequest)) as Partial<MuxSessionPayload> | null

    if (
      !body?.appBaseUrl ||
      !body?.ingestToken ||
      !body?.sessionId ||
      !body?.playbackUrl
    ) {
      outgoingResponse.writeHead(400, { "Content-Type": "application/json" })
      outgoingResponse.end(JSON.stringify({ error: "Invalid Mux session payload." }))
      return
    }

    const session = new IngestSession({
      appBaseUrl: body.appBaseUrl,
      chunkPath: `/api/mux/live-streams/${body.sessionId}/chunk`,
      ingestToken: body.ingestToken,
      inputUrl: body.playbackUrl,
      kind: "mux",
      perfPath: `/api/mux/live-streams/${body.sessionId}/perf`,
      sessionId: body.sessionId,
      statusPath: `/api/mux/live-streams/${body.sessionId}/status`,
    })

    await createOrReplaceSession("mux", body.sessionId, session)

    outgoingResponse.writeHead(200, { "Content-Type": "application/json" })
    outgoingResponse.end(JSON.stringify({ ok: true }))
    return
  }

  if (method === "POST" && /^\/sessions\/[^/]+\/stop$/u.test(url.pathname)) {
    const sessionId = url.pathname.split("/")[2]
    const stopped = await stopSession("rtmp", sessionId)

    if (!stopped) {
      outgoingResponse.writeHead(404, { "Content-Type": "application/json" })
      outgoingResponse.end(JSON.stringify({ error: "Session not found." }))
      return
    }

    outgoingResponse.writeHead(200, { "Content-Type": "application/json" })
    outgoingResponse.end(JSON.stringify({ ok: true }))
    return
  }

  if (method === "POST" && /^\/mux-sessions\/[^/]+\/stop$/u.test(url.pathname)) {
    const sessionId = url.pathname.split("/")[2]
    const stopped = await stopSession("mux", sessionId)

    if (!stopped) {
      outgoingResponse.writeHead(404, { "Content-Type": "application/json" })
      outgoingResponse.end(JSON.stringify({ error: "Session not found." }))
      return
    }

    outgoingResponse.writeHead(200, { "Content-Type": "application/json" })
    outgoingResponse.end(JSON.stringify({ ok: true }))
    return
  }

  outgoingResponse.writeHead(404, { "Content-Type": "application/json" })
  outgoingResponse.end(JSON.stringify({ error: "Not found." }))
})

const micRealtimeServer = new WebSocketServer({ noServer: true })

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${PORT}`)
  if (url.pathname !== "/mic-realtime") {
    socket.destroy()
    return
  }

  const token = url.searchParams.get("token")?.trim() || ""
  const payload = token ? verifyQwenLiveToken(token) : null
  if (!payload) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
    socket.destroy()
    return
  }

  micRealtimeServer.handleUpgrade(request, socket, head, (browserSocket) => {
    const bridge = new MicRealtimeBridge(browserSocket, payload)

    void bridge
      .start()
      .then(() => {
        browserSocket.on("message", (message, isBinary) => {
          bridge.handleBrowserMessage(message, isBinary)
        })

        browserSocket.on("close", () => {
          void bridge.stop()
        })

        browserSocket.on("error", () => {
          void bridge.stop()
        })
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : "Unable to start Qwen realtime."
        if (browserSocket.readyState === WebSocket.OPEN) {
          browserSocket.send(JSON.stringify({ error: message, type: "error" }))
          browserSocket.close()
        }
      })
  })
})

server.listen(PORT, "127.0.0.1", () => {
  console.info(`[Ingest] Listening on http://127.0.0.1:${PORT}`)
})
