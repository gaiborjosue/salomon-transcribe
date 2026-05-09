import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { Readable } from "node:stream"

import {
  MAX_CONSECUTIVE_APP_FAILURES,
  MUX_QWEN_AUDIO_FILTER,
  PCM_SAMPLE_RATE,
  QWEN_MIC_SESSION_ROTATE_AFTER_MS,
  QWEN_MIC_UPSTREAM_BUFFER_LIMIT_BYTES,
  QWEN_REALTIME_MODEL,
  QWEN_REALTIME_URL,
  QWEN_UPSTREAM_GRACEFUL_CLOSE_TIMEOUT_MS,
  RECONNECT_DELAY_MS,
} from "@/ingest/src/config"
import {
  extractQwenResponseDoneText,
  nextQwenEventId,
} from "@/ingest/src/qwen/realtime"
import {
  AppControlError,
  type StatusRoutePayload,
} from "@/ingest/src/types"
import type { MuxPerfTrace } from "@/lib/mux-session-types"
import WebSocket from "ws"

export class MuxQwenIngestSession {
  private static readonly QWEN_APPEND_FRAME_BYTES = Math.floor(
    (PCM_SAMPLE_RATE * 2 * 100) / 1000
  )

  private bufferedAudioByteLength = 0
  private bufferedAudioChunks: Buffer[] = []
  private consecutiveAppFailures = 0
  private connectingUpstream = false
  private readonly drainingSockets = new WeakSet<WebSocket>()
  private ffmpegProcess: ChildProcessByStdio<null, Readable, Readable> | null = null
  private isAppPaused = false
  private isStopping = false
  private partialText = ""
  private qwenSocket: WebSocket | null = null
  private readonly qwenSessionStartedAt = Date.now()
  private reconnectTimer: NodeJS.Timeout | null = null
  private responseInFlight = false
  private rotateTimer: NodeJS.Timeout | null = null
  private sawAudio = false
  private responseCreatedAt: number | null = null
  private speechStartedAt: number | null = null
  private speechStoppedAt: number | null = null
  private lastPausedStatusSyncAt = 0
  private pendingFrameBuffer = Buffer.alloc(0)

  constructor(
    private readonly config: {
      appBaseUrl: string
      entriesPath: string
      ingestToken: string
      inputUrl: string
      onStopFromControlPlane: (reason: string) => Promise<void>
      perfPath: string
      sessionId: string
      statusPath: string
    }
  ) {}

  start() {
    void this.startInternal()
  }

  private async startInternal() {
    void this.postStatus("connecting")

    try {
      await this.connectUpstream()
      if (this.isStopping) {
        return
      }
      this.attachFfmpeg()
    } catch (error) {
      if (this.isStopping) {
        return
      }

      const message =
        error instanceof Error
          ? error.message
          : "Unable to connect to Qwen realtime for Mux."

      await this.postStatus("error", message)
      this.scheduleReconnect()
    }
  }

  async stop({ notifyApp = true }: { notifyApp?: boolean } = {}) {
    this.isStopping = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearRotateTimer()
    this.bufferedAudioChunks = []
    this.bufferedAudioByteLength = 0
    this.pendingFrameBuffer = Buffer.alloc(0)

    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill("SIGTERM")
      this.ffmpegProcess = null
    }

    await this.closeUpstreamSocketGracefully(this.qwenSocket)
    this.qwenSocket = null

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
      `[MUX Qwen] Stopping ${this.config.sessionId} after ${this.consecutiveAppFailures} consecutive app failures: ${message}`
    )
    await this.stopFromAppControlPlane(message)
  }

  private async stopFromAppControlPlane(reason: string) {
    if (this.isStopping) {
      return
    }

    console.info(`[MUX Qwen] Stopping ${this.config.sessionId}: ${reason}`)
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
    if (this.isStopping || this.connectingUpstream) {
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
                language: "es",
              },
              modalities: ["text"],
              translation: {
                language: "en",
              },
            },
            type: "session.update",
          })
        )
      })

      qwenSocket.on("message", (rawMessage) => {
        try {
          const event = JSON.parse(
            typeof rawMessage === "string"
              ? rawMessage
              : rawMessage.toString("utf8")
          ) as Record<string, unknown>
          const eventType = typeof event.type === "string" ? event.type : ""
          const isCurrentSocket = this.qwenSocket === qwenSocket

          if (settled && !isCurrentSocket) {
            return
          }

          if (eventType === "error") {
            const message =
              event.error &&
              typeof event.error === "object" &&
              "message" in event.error
                ? String(event.error.message)
                : "Qwen realtime returned an error."
            if (!settled) {
              fail(new Error(message))
              return
            }

            this.partialText = ""
            this.responseInFlight = false
            void this.postStatus("error", message)
            if (!this.isStopping) {
              this.scheduleReconnect()
            }
            return
          }

          if (eventType === "session.updated") {
            this.qwenSocket = qwenSocket
            this.connectingUpstream = false
            this.scheduleRotateTimer()
            this.flushBufferedAudio()
            if (!settled) {
              settled = true
              resolve()
            }
            return
          }

          if (eventType === "input_audio_buffer.speech_started") {
            this.speechStartedAt = Date.now()
            if (!this.isAppPaused) {
              void this.postStatus("connected")
            }
            return
          }

          if (eventType === "input_audio_buffer.speech_stopped") {
            this.speechStoppedAt = Date.now()
            if (!this.isAppPaused) {
              void this.postStatus("transcribing")
            }
            return
          }

          if (eventType === "response.created") {
            this.partialText = ""
            this.responseInFlight = true
            this.responseCreatedAt = Date.now()
            return
          }

          if (eventType === "response.text.delta" && typeof event.delta === "string") {
            this.partialText += event.delta
            return
          }

          if (eventType === "response.text.done" || eventType === "response.done") {
            const startedAt =
              this.speechStartedAt ?? this.responseCreatedAt ?? this.qwenSessionStartedAt
            const stoppedAt = this.speechStoppedAt ?? Date.now()
            const now = Date.now()
            const text =
              eventType === "response.text.done" && typeof event.text === "string"
                ? event.text.trim() || this.partialText.trim()
                : extractQwenResponseDoneText(event) || this.partialText.trim()

            this.responseInFlight = false
            this.partialText = ""
            this.responseCreatedAt = null
            this.speechStartedAt = null
            this.speechStoppedAt = null

            const perf: MuxPerfTrace = {
              fetchRoundTripMs: now - stoppedAt,
              id: randomUUID(),
              networkOverheadMs: undefined,
              queueWaitMs: undefined,
              responseSkipped: false,
              segmentDurationMs: Math.max(0, stoppedAt - startedAt),
              serverClassifierMs: undefined,
              serverTotalMs: now - stoppedAt,
              source: "mux-hls",
              status: text ? "completed" : "skipped",
              textLength: text.length,
              wavEncodeMs: undefined,
              workerTotalMs: Math.max(0, now - startedAt),
            }

            void this.postPerf(perf)

            if (text && !this.isAppPaused) {
              void this.postEntry(text)
            } else if (!this.isAppPaused) {
              void this.postStatus("connected")
            }
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
          this.clearRotateTimer()
        }

        if (!settled) {
          fail(new Error("Qwen realtime connection closed before setup completed."))
          return
        }

        if (!isCurrentSocket) {
          return
        }

        this.connectingUpstream = false

        if (!this.isStopping && !isDraining) {
          this.responseInFlight = false
          this.responseCreatedAt = null
          this.scheduleReconnect()
        }
      })
    })

    if (isRotation) {
      console.info(`[MUX Qwen] Rotated upstream session for ${this.config.sessionId}.`)
    }
  }

  private async rotateUpstream(reason: "session-limit" | "unexpected-close") {
    if (this.isStopping || this.connectingUpstream) {
      return
    }

    const previousSocket = this.qwenSocket

    try {
      await this.connectUpstream({ isRotation: true })
      await this.closeUpstreamSocketGracefully(previousSocket)
      this.responseInFlight = false

      if (reason === "session-limit") {
        console.info(
          `[MUX Qwen] Proactively rotated session for ${this.config.sessionId} before limit.`
        )
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to rotate the Mux translation session."
      await this.postStatus("error", message)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.isStopping || this.reconnectTimer) {
      return
    }

    void this.postStatus("connecting")
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.ffmpegProcess) {
        void this.connectUpstream().catch(async (error) => {
          if (this.isStopping) {
            return
          }

          const message =
            error instanceof Error
              ? error.message
              : "Unable to reconnect to Qwen realtime for Mux."

          await this.postStatus("error", message)
          this.scheduleReconnect()
        })
        return
      }

      void this.startInternal()
    }, RECONNECT_DELAY_MS)
  }

  private attachFfmpeg() {
    if (this.isStopping || this.ffmpegProcess) {
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
        "-af",
        MUX_QWEN_AUDIO_FILTER,
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
    this.pendingFrameBuffer = Buffer.alloc(0)

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
      if (this.isStopping) {
        return
      }
      this.scheduleReconnect()
    })
  }

  private handleAudioChunk(chunk: Buffer) {
    if (this.isStopping || chunk.length === 0) {
      return
    }

    if (this.isAppPaused) {
      const now = Date.now()
      if (now - this.lastPausedStatusSyncAt >= 2_000) {
        this.lastPausedStatusSyncAt = now
        void this.postStatus("connected")
      }
      return
    }

    const frames = this.extractRealtimeFrames(chunk)
    for (const frame of frames) {
      if (
        !this.qwenSocket ||
        this.qwenSocket.readyState !== WebSocket.OPEN ||
        this.connectingUpstream
      ) {
        this.bufferAudio(frame)
        continue
      }

      this.qwenSocket.send(
        JSON.stringify({
          audio: frame.toString("base64"),
          event_id: nextQwenEventId(),
          type: "input_audio_buffer.append",
        })
      )
    }
  }

  private extractRealtimeFrames(chunk: Buffer) {
    const frameBytes = MuxQwenIngestSession.QWEN_APPEND_FRAME_BYTES
    if (frameBytes <= 0) {
      return [chunk]
    }

    const combined = this.pendingFrameBuffer.length
      ? Buffer.concat([this.pendingFrameBuffer, chunk])
      : chunk

    const frames: Buffer[] = []
    let offset = 0

    while (offset + frameBytes <= combined.length) {
      frames.push(combined.subarray(offset, offset + frameBytes))
      offset += frameBytes
    }

    this.pendingFrameBuffer =
      offset < combined.length
        ? Buffer.from(combined.subarray(offset))
        : Buffer.alloc(0)

    return frames
  }

  private async postEntry(text: string) {
    try {
      const response = await fetch(new URL(this.config.entriesPath, this.config.appBaseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-salomon-ingest-token": this.config.ingestToken,
        },
        body: JSON.stringify({ text }),
      })

      if (await this.handleAppControlResponse(response, "Transcript entry")) {
        return
      }

      const payload = (await response.json().catch(() => null)) as StatusRoutePayload | null
      this.recordSuccessfulAppContact()
      this.isAppPaused = payload?.currentStatus === "paused"

      if (this.isAppPaused) {
        await this.postStatus("paused")
      } else {
        await this.postStatus("connected")
      }
    } catch (error) {
      if (error instanceof AppControlError) {
        return
      }

      await this.recordAppFailure(
        error instanceof Error
          ? error.message
          : "Unable to append the Mux transcript entry."
      )
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

      if (await this.handleAppControlResponse(response, "Status update")) {
        return
      }

      const payload = (await response.json().catch(() => null)) as StatusRoutePayload | null
      this.recordSuccessfulAppContact()
      this.isAppPaused = payload?.currentStatus === "paused"
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
        error instanceof Error ? error.message : "MUX perf event failed."
      )
    }
  }
}
