import WebSocket from "ws"

import {
  QWEN_MIC_SESSION_ROTATE_AFTER_MS,
  QWEN_MIC_UPSTREAM_BUFFER_LIMIT_BYTES,
  QWEN_REALTIME_MODEL,
  QWEN_REALTIME_URL,
  QWEN_UPSTREAM_GRACEFUL_CLOSE_TIMEOUT_MS,
} from "@/ingest/src/config"
import {
  extractQwenResponseDoneText,
  nextQwenEventId,
} from "@/ingest/src/qwen/realtime"

export class MicRealtimeBridge {
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
    private readonly browserSocket: WebSocket,
    private readonly config: {
      sourceLanguage: string
      targetLanguage: string
      userId: string
    }
  ) {}

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
    if (this.closed || this.connectingUpstream) {
      throw new Error("Mic bridge is closed.")
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

    if (isRotation) {
      console.info(
        `[MicRealtime] Rotated upstream Qwen session for user ${this.config.userId}.`
      )
    }
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
