import { randomUUID } from "node:crypto"
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"

import type {
  LivestreamSessionSnapshot,
  LivestreamSessionStatus,
} from "@/lib/livestream-types"
import { isPermanentSonioxError, SONIOX_SAMPLE_RATE, SonioxAudioStream } from "@/lib/soniox-server"
import type { TranscriptCaption, TranscriptEntry } from "@/lib/transcript-types"
import {
  dedupeBoundaryText,
  normalizeWhitespace,
} from "@/lib/transcript-text-utils"

type LivestreamEvent =
  | { type: "partial"; captions: TranscriptCaption[] }
  | { type: "segment"; entry: TranscriptEntry }
  | { type: "snapshot"; snapshot: LivestreamSessionSnapshot }
  | {
      type: "status"
      error?: string
      sourceTitle?: string
      status: LivestreamSessionStatus
    }

const SESSION_IDLE_TTL_MS = 60_000
const MAX_HISTORY_SEGMENTS = 500
const YOUTUBE_AUDIO_FILTER =
  process.env.YOUTUBE_AUDIO_FILTER?.trim() ||
  "dynaudnorm=f=250:g=9:p=0.9:m=8"

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
  private readonly streamUrl: string
  private readonly id: string

  private error?: string
  private ffmpegProcess: ChildProcessByStdio<null, Readable, Readable> | null = null
  private generation = 0
  private history: TranscriptEntry[] = []
  private idleCleanupTimer: NodeJS.Timeout | null = null
  private partialCaptions: TranscriptCaption[] = []
  private stream: SonioxAudioStream | null = null
  private draining: Promise<void> | null = null
  private reconnectTimer: NodeJS.Timeout | undefined
  private sourceTitle?: string
  private startedAtMs: number | null = null
  private status: LivestreamSessionStatus = "idle"
  private terminalNotified = false

  constructor({
    id,
    onTerminalStatus,
    streamUrl,
  }: {
    id: string
    onTerminalStatus?: (sessionId: string) => void
    streamUrl: string
  }) {
    this.id = id
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
    if (this.partialCaptions.length) {
      listener({ type: "partial", captions: this.partialCaptions })
    }
    if (this.idleCleanupTimer && !this.terminalNotified) {
      clearTimeout(this.idleCleanupTimer)
      this.idleCleanupTimer = null
    }

    return () => {
      this.listeners.delete(listener)
      this.scheduleIdleCleanup()
    }
  }

  private emit(event: LivestreamEvent) {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private emitPartial(captions: TranscriptCaption[]) {
    this.partialCaptions = captions
    this.emit({ type: "partial", captions })
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
      clearTimeout(this.idleCleanupTimer ?? undefined)
      this.idleCleanupTimer = setTimeout(() => this.onTerminalStatus?.(this.id), SESSION_IDLE_TTL_MS)
    }
  }

  async start() {
    if (this.status !== "idle") return
    this.startedAtMs = Date.now()
    await this.startIngest()
  }

  private async startIngest() {
    const generation = ++this.generation
    this.setStatus("connecting")

    try {
      await this.draining
      if (generation !== this.generation) return

      const metadata = await resolveLivestreamMetadata(this.streamUrl)
      if (generation !== this.generation) return
      if (!metadata.directAudioUrl) {
        throw new Error("Unable to resolve the livestream audio URL from YouTube.")
      }

      this.sourceTitle = metadata.sourceTitle
      const stream = new SonioxAudioStream({
        onError: (error) => {
          if (this.stream === stream && generation === this.generation) {
            void this.handleStreamError(error)
          }
        },
        onFinal: (caption) => {
          this.appendSegment(caption)
          if (generation === this.generation) this.setStatus("connected")
        },
        onPartial: (captions) => {
          if (generation !== this.generation) return
          this.emitPartial(captions)
          if (captions.length && this.status !== "transcribing") this.setStatus("transcribing")
        },
      })
      this.stream = stream
      await stream.connect()
      if (generation !== this.generation) return
      this.attachFfmpeg(metadata.directAudioUrl)
      this.setStatus("connected")
      this.scheduleIdleCleanup()
    } catch (error) {
      if (generation !== this.generation) return
      await this.stopIngest()
      const failure = error as NodeJS.ErrnoException
      const message = failure.code === "ENOENT"
        ? `Required ingest executable "${failure.path || "yt-dlp"}" is not installed.`
        : failure.message
      this.setStatus("error", message)
      throw new Error(message)
    }
  }

  private async handleStreamError(error: Error) {
    const generation = this.generation + 1
    await this.stopIngest()
    if (generation !== this.generation) return

    if (isPermanentSonioxError(error)) {
      this.setStatus("error", error.message)
      return
    }

    this.setStatus("connecting")
    this.reconnectTimer = setTimeout(() => {
      void this.startIngest().catch(() => {
        // startIngest emits the error to listeners.
      })
    }, 3_000)
  }

  private attachFfmpeg(directAudioUrl: string) {
    const ffmpeg = spawn("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
      "-i", directAudioUrl,
      "-vn", "-af", YOUTUBE_AUDIO_FILTER,
      "-ac", "1", "-ar", String(SONIOX_SAMPLE_RATE), "-f", "s16le", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] })

    this.ffmpegProcess = ffmpeg
    ffmpeg.stderr.resume()
    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      if (this.ffmpegProcess !== ffmpeg) return
      try {
        this.stream?.send(chunk)
      } catch (error) {
        void this.handleStreamError(error as Error)
      }
    })

    const handleExit = async (message: string) => {
      if (this.ffmpegProcess !== ffmpeg) return
      this.ffmpegProcess = null
      const generation = this.generation + 1
      await this.stopIngest()
      if (generation === this.generation) this.setStatus("error", message)
    }
    ffmpeg.on("error", (error) => void handleExit(error.message))
    ffmpeg.on("close", () => void handleExit("The livestream audio connection ended unexpectedly."))
  }

  private appendSegment({ speakerId, text }: TranscriptCaption) {
    const nextText = normalizeWhitespace(text)
    if (!nextText) {
      return
    }

    const previous = this.history.at(-1)
    const dedupedText = dedupeBoundaryText(
      previous?.speakerId === speakerId ? previous?.text ?? "" : "",
      nextText
    )
    if (!dedupedText) {
      return
    }

    const timestampMs = this.startedAtMs ? Date.now() - this.startedAtMs : 0
    const entry: TranscriptEntry = {
      id: randomUUID(),
      speakerId,
      text: dedupedText,
      timestampMs,
    }

    this.history = [...this.history, entry].slice(-MAX_HISTORY_SEGMENTS)

    this.emit({
      type: "segment",
      entry,
    })
  }

  private stopIngest() {
    this.generation += 1
    clearTimeout(this.reconnectTimer)
    const ffmpeg = this.ffmpegProcess
    this.ffmpegProcess = null
    ffmpeg?.kill("SIGTERM")

    const stream = this.stream
    this.stream = null
    this.emitPartial([])
    if (stream) {
      this.draining = stream.finish().catch((error: Error) => {
        console.warn(`[Livestream Soniox] Could not finish ${this.id}: ${error.message}`)
      })
    }
    return this.draining
  }

  private scheduleIdleCleanup() {
    if (this.listeners.size > 0 || this.idleCleanupTimer || this.terminalNotified) return
    this.idleCleanupTimer = setTimeout(() => {
      void this.stop()
    }, SESSION_IDLE_TTL_MS)
  }

  async pause() {
    if (this.status !== "connected" && this.status !== "transcribing") return
    this.setStatus("paused")
    await this.stopIngest()
  }

  async resume() {
    if (this.status === "paused") await this.startIngest()
  }

  async stop() {
    clearTimeout(this.idleCleanupTimer ?? undefined)
    this.idleCleanupTimer = null
    await this.stopIngest()
    this.setStatus("disconnected")
  }
}

class LivestreamSessionManager {
  private readonly sessions = new Map<string, LivestreamSession>()

  async createSession(streamUrl: string) {
    const id = randomUUID()
    const session = new LivestreamSession({
      id,
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

const LIVESTREAM_SESSION_MANAGER_VERSION = 5

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
