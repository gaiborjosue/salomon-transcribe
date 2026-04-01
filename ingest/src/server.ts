import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import type { Readable } from "node:stream"

import {
  ServerSpeechSegmenter,
  getServerSpeechSegmenterConfig,
} from "@/lib/server-speech-segmenter"
import type { MuxPerfTrace } from "@/lib/mux-session-types"
import type { AudioTranslationMetrics } from "@/lib/process-audio-translation"

const PORT = Number(process.env.INGEST_PORT || 4100)
const RTMP_INPUT_BASE_URL =
  process.env.MEDIAMTX_RTMP_BASE_URL ?? "rtmp://127.0.0.1:1935/live"
const PCM_SAMPLE_RATE = 16000
const MAX_CHUNK_QUEUE_DURATION_MS = 60_000
const MAX_CONSECUTIVE_APP_FAILURES = 5
const RECONNECT_DELAY_MS = 3_000
const STREAM_SEGMENTER_CONFIG = getServerSpeechSegmenterConfig("sermon")

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

server.listen(PORT, "127.0.0.1", () => {
  console.info(`[Ingest] Listening on http://127.0.0.1:${PORT}`)
})
