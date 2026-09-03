import { randomUUID } from "node:crypto"
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import WebSocket from "ws"

import type {
  LivestreamMode,
  LivestreamSessionSnapshot,
  LivestreamSessionStatus,
  LivestreamTranscriptEntry,
} from "@/lib/livestream-types"
import {
  dedupeBoundaryText,
  normalizeWhitespace,
} from "@/lib/transcript-text-utils"

type LivestreamEvent =
  | { type: "partial"; text: string }
  | { type: "segment"; entry: LivestreamTranscriptEntry }
  | { type: "snapshot"; snapshot: LivestreamSessionSnapshot }
  | {
      type: "status"
      error?: string
      sourceTitle?: string
      status: LivestreamSessionStatus
    }

const SESSION_IDLE_TTL_MS = 60_000
const MAX_HISTORY_SEGMENTS = 500
const QWEN_REALTIME_URL =
  process.env.DASHSCOPE_REALTIME_URL?.trim() ||
  (process.env.DASHSCOPE_REGION === "cn"
    ? "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    : "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime")
const QWEN_REALTIME_MODEL =
  process.env.DASHSCOPE_TRANSLATION_MODEL?.trim() ||
  "qwen3-livetranslate-flash-realtime"
const QWEN_LIVESTREAM_SESSION_ROTATE_AFTER_MS = Number(
  process.env.QWEN_LIVESTREAM_SESSION_ROTATE_AFTER_MS ??
    process.env.QWEN_MIC_SESSION_ROTATE_AFTER_MS ??
    String(110 * 60 * 1000)
)
const QWEN_UPSTREAM_GRACEFUL_CLOSE_TIMEOUT_MS = Number(
  process.env.QWEN_UPSTREAM_GRACEFUL_CLOSE_TIMEOUT_MS ?? "2500"
)
const YOUTUBE_AUDIO_FILTER =
  process.env.YOUTUBE_QWEN_AUDIO_FILTER?.trim() ||
  "dynaudnorm=f=250:g=9:p=0.9:m=8"
const QWEN_LIVESTREAM_VAD_THRESHOLD = Number(
  process.env.QWEN_LIVESTREAM_VAD_THRESHOLD ??
    process.env.QWEN_MIC_VAD_THRESHOLD ??
    "0.1"
)
const QWEN_LIVESTREAM_VAD_SILENCE_MS = Number(
  process.env.QWEN_LIVESTREAM_VAD_SILENCE_MS ??
    process.env.QWEN_MIC_VAD_SILENCE_MS ??
    "1100"
)
const QWEN_LIVESTREAM_VAD_PREFIX_PADDING_MS = Number(
  process.env.QWEN_LIVESTREAM_VAD_PREFIX_PADDING_MS ??
    process.env.QWEN_MIC_VAD_PREFIX_PADDING_MS ??
    "400"
)

function nextQwenEventId() {
  return `event_${randomUUID().replace(/-/gu, "")}`
}

function isInactiveStatus(status: LivestreamSessionStatus) {
  return status === "paused" || status === "disconnected" || status === "error"
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

async function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    child.on("error", (error) => {
      reject(error)
    })

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim())
        return
      }

      reject(
        new Error(
          stderr.trim() ||
            `Command "${command}" failed with exit code ${code ?? "unknown"}.`
        )
      )
    })
  })
}

async function resolveLivestreamMetadata(streamUrl: string) {
  const [titleOutput, directUrlOutput] = await Promise.all([
    runCommand("yt-dlp", [
      "--js-runtimes",
      "node",
      "--no-playlist",
      "--print",
      "%(title)s",
      streamUrl,
    ]),
    runCommand("yt-dlp", [
      "--js-runtimes",
      "node",
      "--no-playlist",
      "-f",
      "bestaudio/best",
      "-g",
      streamUrl,
    ]),
  ])

  return {
    directAudioUrl: directUrlOutput.split(/\r?\n/).find(Boolean)?.trim() || "",
    sourceTitle: titleOutput.split(/\r?\n/).find(Boolean)?.trim() || "YouTube livestream",
  }
}

class LivestreamSession {
  private readonly onTerminalStatus?: (sessionId: string) => void
  private readonly listeners = new Set<(event: LivestreamEvent) => void>()
  private readonly mode: LivestreamMode
  private readonly streamUrl: string
  private readonly id: string

  private readonly drainingSockets = new WeakSet<WebSocket>()
  private connectingUpstream = false
  private error?: string
  private ffmpegProcess: ChildProcessByStdio<null, Readable, Readable> | null =
    null
  private finalDeliveredForResponse = false
  private history: LivestreamTranscriptEntry[] = []
  private idleCleanupTimer: NodeJS.Timeout | null = null
  private isStoppingProcess = false
  private partialText = ""
  private qwenSocket: WebSocket | null = null
  private rotateTimer: NodeJS.Timeout | null = null
  private sourceTitle?: string
  private startedAtMs: number | null = null
  private status: LivestreamSessionStatus = "idle"
  private terminalNotified = false

  constructor({
    id,
    mode,
    onTerminalStatus,
    streamUrl,
  }: {
    id: string
    mode: LivestreamMode
    onTerminalStatus?: (sessionId: string) => void
    streamUrl: string
  }) {
    this.id = id
    this.mode = mode
    this.onTerminalStatus = onTerminalStatus
    this.streamUrl = streamUrl
  }

  getSnapshot(): LivestreamSessionSnapshot {
    return {
      error: this.error,
      id: this.id,
      segments: this.history,
      sourceTitle: this.sourceTitle,
      status: this.status,
      streamUrl: this.streamUrl,
    }
  }

  subscribe(listener: (event: LivestreamEvent) => void) {
    this.listeners.add(listener)
    listener({ type: "snapshot", snapshot: this.getSnapshot() })
    if (this.partialText.trim()) {
      listener({ type: "partial", text: this.partialText.trim() })
    }
    if (this.idleCleanupTimer) {
      clearTimeout(this.idleCleanupTimer)
      this.idleCleanupTimer = null
    }

    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.status !== "disconnected") {
        this.idleCleanupTimer = setTimeout(() => {
          void this.stop()
        }, SESSION_IDLE_TTL_MS)
      }
    }
  }

  private emit(event: LivestreamEvent) {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private emitPartial(text: string) {
    this.emit({ type: "partial", text })
  }

  private setStatus(status: LivestreamSessionStatus, error?: string) {
    this.status = status
    this.error = error
    this.emit({
      type: "status",
      error,
      sourceTitle: this.sourceTitle,
      status,
    })

    if (
      !this.terminalNotified &&
      (status === "disconnected" || status === "error")
    ) {
      this.terminalNotified = true
      this.onTerminalStatus?.(this.id)
    }
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
    }, QWEN_LIVESTREAM_SESSION_ROTATE_AFTER_MS)
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

  private async connectUpstream({
    isRotation = false,
  }: {
    isRotation?: boolean
  } = {}) {
    const apiKey = process.env.DASHSCOPE_API_KEY?.trim()
    if (!apiKey) {
      throw new Error("DASHSCOPE_API_KEY is not configured.")
    }

    if (this.connectingUpstream || isInactiveStatus(this.status)) {
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
              turn_detection: {
                prefix_padding_ms: QWEN_LIVESTREAM_VAD_PREFIX_PADDING_MS,
                silence_duration_ms: QWEN_LIVESTREAM_VAD_SILENCE_MS,
                threshold: QWEN_LIVESTREAM_VAD_THRESHOLD,
                type: "server_vad",
              },
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
            this.emitPartial("")
            this.setStatus("error", message)
            this.stopIngestProcess()
            return
          }

          if (eventType === "session.updated") {
            this.qwenSocket = qwenSocket
            this.connectingUpstream = false
            this.scheduleRotateTimer()
            if (!settled) {
              settled = true
              resolve()
            }
            return
          }

          if (eventType === "input_audio_buffer.speech_started") {
            if (!isInactiveStatus(this.status) && this.status !== "connected") {
              this.setStatus("connected")
            }
            return
          }

          if (eventType === "input_audio_buffer.speech_stopped") {
            if (!isInactiveStatus(this.status)) {
              this.setStatus("transcribing")
            }
            return
          }

          if (eventType === "response.created") {
            this.partialText = ""
            this.finalDeliveredForResponse = false
            return
          }

          if (eventType === "response.text.delta" && typeof event.delta === "string") {
            this.partialText += event.delta
            this.emitPartial(this.partialText)
            return
          }

          if (eventType === "response.text.done" && typeof event.text === "string") {
            const text = event.text.trim() || this.partialText.trim()
            if (text && !this.finalDeliveredForResponse) {
              this.finalDeliveredForResponse = true
              this.appendSegment(text)
            }
            this.partialText = ""
            this.emitPartial("")
            if (!isInactiveStatus(this.status)) {
              this.setStatus("connected")
            }
            return
          }

          if (eventType === "response.done") {
            const text = extractQwenResponseDoneText(event) || this.partialText.trim()
            if (text && !this.finalDeliveredForResponse) {
              this.finalDeliveredForResponse = true
              this.appendSegment(text)
            }
            this.partialText = ""
            this.emitPartial("")
            if (!isInactiveStatus(this.status)) {
              this.setStatus("connected")
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

        if (!isInactiveStatus(this.status) && !isDraining) {
          void this.rotateUpstream("unexpected-close")
        }
      })
    })

    if (isRotation) {
      console.info(`[Livestream][Qwen] Rotated upstream session for ${this.id}.`)
    }
  }

  private async rotateUpstream(reason: "session-limit" | "unexpected-close") {
    if (this.connectingUpstream || isInactiveStatus(this.status)) {
      return
    }

    const previousSocket = this.qwenSocket

    try {
      await this.connectUpstream({ isRotation: true })
      await this.closeUpstreamSocketGracefully(previousSocket)

      if (reason === "session-limit") {
        console.info(
          `[Livestream][Qwen] Proactively rotated session for ${this.id} before limit.`
        )
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to rotate the livestream translation session."
      this.setStatus("error", message)
      this.stopIngestProcess()
    }
  }

  async start() {
    if (this.status !== "idle") {
      return
    }

    this.setStatus("connecting")
    this.startedAtMs = Date.now()

    try {
      const metadata = await resolveLivestreamMetadata(this.streamUrl)
      if (!metadata.directAudioUrl) {
        throw new Error("Unable to resolve the livestream audio URL from YouTube.")
      }

      this.sourceTitle = metadata.sourceTitle
      this.emit({
        type: "status",
        sourceTitle: this.sourceTitle,
        status: "connecting",
      })

      await this.connectUpstream()
      this.attachFfmpeg(metadata.directAudioUrl)
      this.setStatus("connected")
    } catch (error) {
      const maybeErrno = error as NodeJS.ErrnoException
      const message =
        error instanceof Error
          ? maybeErrno.code === "ENOENT"
            ? `Required ingest executable "${maybeErrno.path || "yt-dlp"}" is not installed.`
            : error.message
          : "Unable to start the livestream session."
      this.setStatus("error", message)
      throw new Error(message)
    }
  }

  private attachFfmpeg(directAudioUrl: string) {
    this.stopIngestProcess()

    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
        "-i",
        directAudioUrl,
        "-vn",
        "-af",
        YOUTUBE_AUDIO_FILTER,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "pipe:1",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    )

    this.ffmpegProcess = ffmpeg
    this.isStoppingProcess = false

    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      this.handleAudioChunk(chunk)
    })

    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim()
      if (message) {
        this.error = message
      }
    })

    ffmpeg.on("error", (error) => {
      if (this.isStoppingProcess) return
      this.setStatus("error", error.message)
    })

    ffmpeg.on("close", () => {
      const wasIntentional = this.isStoppingProcess
      this.ffmpegProcess = null
      this.isStoppingProcess = false

      if (wasIntentional || isInactiveStatus(this.status)) {
        return
      }

      this.setStatus("error", "The livestream audio connection ended unexpectedly.")
    })
  }

  private stopIngestProcess() {
    if (!this.ffmpegProcess) {
      return
    }

    this.isStoppingProcess = true
    this.ffmpegProcess.kill("SIGTERM")
    this.ffmpegProcess = null
  }

  private handleAudioChunk(chunk: Buffer) {
    if (isInactiveStatus(this.status)) {
      return
    }

    if (
      !this.qwenSocket ||
      this.qwenSocket.readyState !== WebSocket.OPEN ||
      this.connectingUpstream
    ) {
      return
    }

    this.qwenSocket.send(
      JSON.stringify({
        audio: chunk.toString("base64"),
        event_id: nextQwenEventId(),
        type: "input_audio_buffer.append",
      })
    )
  }

  private appendSegment(text: string, lowConfidence = false) {
    const nextText = normalizeWhitespace(text)
    if (!nextText) {
      return
    }

    const previousText = this.history[this.history.length - 1]?.text || ""
    const dedupedText = dedupeBoundaryText(previousText, nextText)
    if (!dedupedText) {
      return
    }

    const timestampMs = this.startedAtMs ? Date.now() - this.startedAtMs : 0
    const entry: LivestreamTranscriptEntry = {
      id: `${Date.now()}-${this.history.length}`,
      lowConfidence,
      text: dedupedText,
      timestampMs,
    }

    this.history = [...this.history, entry].slice(-MAX_HISTORY_SEGMENTS)

    this.emit({
      type: "segment",
      entry,
    })
  }

  private async stopUpstream() {
    this.clearRotateTimer()
    this.partialText = ""
    this.emitPartial("")

    const currentSocket = this.qwenSocket
    if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
      await this.closeUpstreamSocketGracefully(currentSocket)
      if (this.qwenSocket === currentSocket) {
        this.qwenSocket = null
      }
      this.connectingUpstream = false
      return
    }

    try {
      currentSocket?.close()
    } catch {
      // noop
    }

    this.qwenSocket = null
    this.connectingUpstream = false
  }

  async pause() {
    if (this.status !== "connected" && this.status !== "transcribing") {
      return
    }

    this.setStatus("paused")
    this.stopIngestProcess()
    await this.stopUpstream()
  }

  async resume() {
    if (this.status !== "paused") {
      return
    }

    this.setStatus("connecting")

    try {
      const metadata = await resolveLivestreamMetadata(this.streamUrl)
      if (!metadata.directAudioUrl) {
        throw new Error("Unable to reconnect to the livestream audio feed.")
      }

      this.sourceTitle = metadata.sourceTitle
      await this.connectUpstream()
      this.attachFfmpeg(metadata.directAudioUrl)
      this.setStatus("connected")
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to resume livestream."
      this.setStatus("error", message)
      throw new Error(message)
    }
  }

  async stop() {
    this.stopIngestProcess()
    await this.stopUpstream()
    this.setStatus("disconnected")
  }
}

class LivestreamSessionManager {
  private readonly sessions = new Map<string, LivestreamSession>()

  async createSession({
    mode,
    streamUrl,
  }: {
    mode: LivestreamMode
    streamUrl: string
  }) {
    const id = randomUUID()
    const session = new LivestreamSession({
      id,
      mode,
      onTerminalStatus: (sessionId) => {
        this.sessions.delete(sessionId)
      },
      streamUrl,
    })
    this.sessions.set(id, session)

    try {
      await session.start()
    } catch (error) {
      this.sessions.delete(id)
      throw error
    }

    return session
  }

  getSession(id: string) {
    return this.sessions.get(id)
  }

  async stopSession(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    await session.stop()
    this.sessions.delete(id)
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __livestreamSessionManager__: LivestreamSessionManager | undefined
  // eslint-disable-next-line no-var
  var __livestreamSessionManagerVersion__: number | undefined
}

const LIVESTREAM_SESSION_MANAGER_VERSION = 4

if (
  !globalThis.__livestreamSessionManager__ ||
  globalThis.__livestreamSessionManagerVersion__ !==
    LIVESTREAM_SESSION_MANAGER_VERSION
) {
  globalThis.__livestreamSessionManager__ = new LivestreamSessionManager()
  globalThis.__livestreamSessionManagerVersion__ =
    LIVESTREAM_SESSION_MANAGER_VERSION
}

export const livestreamSessionManager = globalThis.__livestreamSessionManager__
