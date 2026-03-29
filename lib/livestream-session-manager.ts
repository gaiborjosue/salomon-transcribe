import { randomUUID } from "node:crypto"
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"

import type {
  LivestreamMode,
  LivestreamSessionSnapshot,
  LivestreamSessionStatus,
  LivestreamTranscriptEntry,
} from "@/lib/livestream-types"
import {
  audioContentClassifier,
  shouldSkipForMusic,
} from "@/lib/audio-content-classifier"
import {
  dedupeBoundaryText,
  normalizeWhitespace,
} from "@/lib/transcript-text-utils"
import { assessGroqTranslation, translateAudioChunk } from "@/lib/groq-translation"

type LivestreamEvent =
  | { type: "segment"; entry: LivestreamTranscriptEntry }
  | { type: "snapshot"; snapshot: LivestreamSessionSnapshot }
  | { type: "status"; error?: string; sourceTitle?: string; status: LivestreamSessionStatus }

interface ChunkConfig {
  chunkDurationMs: number
  overlapMs: number
}

const PCM_SAMPLE_RATE = 16000
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2
const SESSION_IDLE_TTL_MS = 60_000
const MAX_CONTEXT_SEGMENTS = 2
const MAX_HISTORY_SEGMENTS = 500

function isInactiveStatus(status: LivestreamSessionStatus) {
  return status === "paused" || status === "disconnected" || status === "error"
}

function getChunkConfig(mode: LivestreamMode): ChunkConfig {
  if (mode === "sermon") {
    return {
      chunkDurationMs: 14_000,
      overlapMs: 1_800,
    }
  }

  return {
    chunkDurationMs: 8_000,
    overlapMs: 1_000,
  }
}

function encodeWav(audioBuffer: Buffer, sampleRate: number): Buffer {
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
    runCommand("yt-dlp", ["--no-playlist", "--print", "%(title)s", streamUrl]),
    runCommand("yt-dlp", ["--no-playlist", "-f", "bestaudio/best", "-g", streamUrl]),
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

  private audioBuffer = Buffer.alloc(0)
  private chunkQueue: Buffer[] = []
  private committedTranslations: string[] = []
  private error?: string
  private ffmpegProcess: ChildProcessByStdio<null, Readable, Readable> | null =
    null
  private history: LivestreamTranscriptEntry[] = []
  private idleCleanupTimer: NodeJS.Timeout | null = null
  private isStoppingProcess = false
  private isTranslating = false
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

      this.attachFfmpeg(metadata.directAudioUrl)
      this.setStatus("connected")
    } catch (error) {
      const maybeErrno = error as NodeJS.ErrnoException
      const message =
        error instanceof Error
          ? maybeErrno.code === "ENOENT"
            ? 'yt-dlp is not installed. Run "brew install yt-dlp" first.'
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
        "-ac",
        "1",
        "-ar",
        String(PCM_SAMPLE_RATE),
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

      if (wasIntentional || this.status === "paused" || this.status === "disconnected") {
        return
      }

      this.flushResidualAudio()
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
    if (this.status === "paused" || this.status === "disconnected") {
      return
    }

    this.audioBuffer = Buffer.concat([this.audioBuffer, chunk])
    const { chunkDurationMs, overlapMs } = getChunkConfig(this.mode)
    const chunkBytes = Math.round((chunkDurationMs / 1000) * PCM_BYTES_PER_SECOND)
    const overlapBytes = Math.round((overlapMs / 1000) * PCM_BYTES_PER_SECOND)

    while (this.audioBuffer.length >= chunkBytes) {
      const nextChunk = this.audioBuffer.subarray(0, chunkBytes)
      this.chunkQueue.push(Buffer.from(nextChunk))
      this.audioBuffer = Buffer.from(this.audioBuffer.subarray(chunkBytes - overlapBytes))
    }

    void this.processQueue()
  }

  private flushResidualAudio() {
    const minimumBytes = Math.round(3 * PCM_BYTES_PER_SECOND)
    if (this.audioBuffer.length >= minimumBytes) {
      this.chunkQueue.push(Buffer.from(this.audioBuffer))
    }
    this.audioBuffer = Buffer.alloc(0)
    void this.processQueue()
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
    this.committedTranslations = [...this.committedTranslations, dedupedText].slice(
      -MAX_CONTEXT_SEGMENTS
    )

    this.emit({
      type: "segment",
      entry,
    })
  }

  private async processQueue() {
    if (
      this.isTranslating ||
      this.chunkQueue.length === 0 ||
      this.status === "paused" ||
      this.status === "disconnected" ||
      this.status === "error"
    ) {
      return
    }

    const nextChunk = this.chunkQueue.shift()
    if (!nextChunk) {
      return
    }

    this.isTranslating = true
    this.setStatus("transcribing")

    try {
      let classification:
        | Awaited<ReturnType<typeof audioContentClassifier.classifyPcm16>>
        | undefined
      let classifierMs: number | undefined

      try {
        const classifyStartedAt = performance.now()
        classification = await audioContentClassifier.classifyPcm16(
          nextChunk,
          PCM_SAMPLE_RATE
        )
        classifierMs = performance.now() - classifyStartedAt

        if (shouldSkipForMusic(classification)) {
          console.info(
            `[Livestream][Timing] skipped=music classifier=${classifierMs.toFixed(1)}ms top=${classification.topLabel} speech=${classification.speechScore.toFixed(3)} music=${classification.musicScore.toFixed(3)}`
          )
          if (isInactiveStatus(this.status as LivestreamSessionStatus)) {
            return
          }
          this.setStatus("connected")
          return
        }
      } catch {
        // If the local classifier is unavailable, fall back to normal translation.
      }

      const wavBuffer = encodeWav(nextChunk, PCM_SAMPLE_RATE)
      const audioFile = new File([wavBuffer], "livestream-chunk.wav", {
        type: "audio/wav",
      })
      const groqStartedAt = performance.now()
      const payload = await translateAudioChunk({
        audioFile,
        context: this.committedTranslations.join(" ").trim(),
      })
      const groqMs = performance.now() - groqStartedAt

      if (isInactiveStatus(this.status as LivestreamSessionStatus)) {
        return
      }

      const assessment = assessGroqTranslation(payload)

      console.info(
        `[Livestream][Timing] skipped=false classifier=${classifierMs?.toFixed(1) ?? "n/a"}ms groq=${groqMs.toFixed(1)}ms${classification ? ` top=${classification.topLabel} speech=${classification.speechScore.toFixed(3)} music=${classification.musicScore.toFixed(3)}` : ""}`
      )

      if (assessment.text) {
        this.appendSegment(assessment.text, assessment.lowConfidence)
      }
      this.setStatus("connected")
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Groq translation failed."
      this.setStatus("error", message)
    } finally {
      this.isTranslating = false
    }

    if (this.chunkQueue.length > 0 && !isInactiveStatus(this.status as LivestreamSessionStatus)) {
      void this.processQueue()
    }
  }

  async pause() {
    if (this.status !== "connected" && this.status !== "transcribing") {
      return
    }

    this.setStatus("paused")
    this.stopIngestProcess()
    this.audioBuffer = Buffer.alloc(0)
    this.chunkQueue = []
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
    this.audioBuffer = Buffer.alloc(0)
    this.chunkQueue = []
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

const LIVESTREAM_SESSION_MANAGER_VERSION = 2

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
