import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { Readable } from "node:stream"

import {
  MAX_CHUNK_QUEUE_DURATION_MS,
  MAX_CONSECUTIVE_APP_FAILURES,
  PCM_SAMPLE_RATE,
  RECONNECT_DELAY_MS,
  STREAM_SEGMENTER_CONFIG,
} from "@/ingest/src/config"
import { encodeWav } from "@/ingest/src/utils/audio"
import {
  AppControlError,
  type ChunkRoutePayload,
  type QueuedChunk,
  type SessionKind,
} from "@/ingest/src/types"
import { ServerSpeechSegmenter } from "@/lib/server-speech-segmenter"
import type { MuxPerfTrace } from "@/lib/mux-session-types"

export class ChunkedIngestSession {
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
      onStopFromControlPlane: (reason: string) => Promise<void>
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
    await this.config.onStopFromControlPlane(reason)
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
