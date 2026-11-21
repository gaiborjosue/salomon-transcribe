import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { Readable } from "node:stream"

import { MAX_CONSECUTIVE_APP_FAILURES, RECONNECT_DELAY_MS } from "@/ingest/src/config"
import type { StatusRoutePayload } from "@/ingest/src/types"
import { isPermanentSonioxError, SONIOX_SAMPLE_RATE, SonioxAudioStream } from "@/lib/soniox-server"
import type { TranscriptCaption } from "@/lib/transcript-types"
import type { LivestreamSessionStatus } from "@/lib/livestream-types"

export class MediaIngestSession {
  private appRequests = Promise.resolve()
  private consecutiveAppFailures = 0
  private ffmpeg: ChildProcessByStdio<null, Readable, Readable> | null = null
  private stream: SonioxAudioStream | null = null
  private draining: Promise<void> | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private statusTimer: NodeJS.Timeout | undefined
  private pollingStatus = false
  private paused = false
  private stopped = false
  private stopPromise: Promise<void> | undefined
  private segmentStartedAt: number | undefined
  private status: LivestreamSessionStatus = "connecting"

  constructor(
    private readonly config: {
      appBaseUrl: string
      audioFilter?: string
      entriesPath: string
      ingestToken: string
      inputUrl: string
      onStopFromControlPlane: (session: MediaIngestSession) => Promise<boolean>
      perfPath?: string
      sessionId: string
      statusPath: string
    }
  ) {}

  start() {
    this.postStatus("connecting")
    this.attachFfmpeg()
    this.statusTimer = setInterval(() => {
      if (this.pollingStatus) return
      this.pollingStatus = true
      void this.requestApp(this.config.statusPath).finally(() => {
        this.pollingStatus = false
      })
    }, 2_000)
  }

  stop({ notifyApp = true }: { notifyApp?: boolean } = {}) {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    clearInterval(this.statusTimer)
    this.stopPromise ??= this.stopInternal(notifyApp)
    return this.stopPromise
  }

  private async stopInternal(notifyApp: boolean) {
    const ffmpeg = this.ffmpeg
    this.ffmpeg = null
    ffmpeg?.kill("SIGTERM")
    await this.finishStream()
    if (notifyApp) this.postStatus("disconnected")
    await this.appRequests
  }

  private finishStream() {
    const stream = this.stream
    this.stream = null
    if (stream) {
      this.draining = stream.finish().catch((error: Error) => {
        console.warn(`[Media Soniox] Could not finish ${this.config.sessionId}: ${error.message}`)
      })
    }
    return this.draining
  }

  private attachFfmpeg() {
    const ffmpeg = spawn("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-i", this.config.inputUrl,
      "-vn",
      ...(this.config.audioFilter ? ["-af", this.config.audioFilter] : []),
      "-ac", "1", "-ar", String(SONIOX_SAMPLE_RATE), "-f", "s16le", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] })

    this.ffmpeg = ffmpeg
    ffmpeg.stderr.resume()
    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      if (this.ffmpeg !== ffmpeg || this.paused) return
      if (this.stream) {
        try {
          this.stream.send(chunk)
        } catch (error) {
          void this.restart(ffmpeg, error as Error)
        }
        return
      }

      ffmpeg.stdout.pause()
      void this.connectStream(ffmpeg, chunk)
    })
    ffmpeg.on("error", (error) => void this.restart(ffmpeg, error))
    ffmpeg.on("close", () => void this.restart(ffmpeg))
  }

  private async connectStream(ffmpeg: NonNullable<MediaIngestSession["ffmpeg"]>, firstChunk: Buffer) {
    try {
      const stream = new SonioxAudioStream({
        onError: (error) => {
          if (this.stream === stream) void this.restart(ffmpeg, error)
        },
        onFinal: (caption) => this.postEntry(caption),
        onPartial: (captions) => {
          if (captions.length && !this.paused && !this.stopped && this.status !== "transcribing") {
            this.segmentStartedAt = performance.now()
            this.postStatus("transcribing")
          }
        },
      })
      this.stream = stream
      await stream.connect()
      if (this.stream !== stream || this.ffmpeg !== ffmpeg || this.paused) return
      this.postStatus("connected")
      stream.send(firstChunk)
    } catch (error) {
      if (!this.paused) await this.restart(ffmpeg, error as Error)
    } finally {
      if (this.ffmpeg === ffmpeg) ffmpeg.stdout.resume()
    }
  }

  private async restart(ffmpeg: NonNullable<MediaIngestSession["ffmpeg"]>, error?: Error) {
    if (this.ffmpeg !== ffmpeg || this.stopped) return
    this.ffmpeg = null
    ffmpeg.kill("SIGTERM")
    await this.finishStream()
    this.segmentStartedAt = undefined
    if (this.stopped) return

    if (error && (
      isPermanentSonioxError(error) ||
      !process.env.SONIOX_API_KEY?.trim()
    )) {
      this.postStatus("error", error.message)
      clearInterval(this.statusTimer)
      return
    }

    if (error) console.warn(`[Media Soniox] Reconnecting ${this.config.sessionId}: ${error.message}`)
    this.postStatus("connecting")
    this.reconnectTimer = setTimeout(() => this.attachFfmpeg(), RECONNECT_DELAY_MS)
  }

  private postEntry(caption: TranscriptCaption) {
    if (this.paused) return

    this.requestApp(this.config.entriesPath, caption)
    if (this.config.perfPath) {
      const partialToFinalMs = this.segmentStartedAt === undefined
        ? undefined
        : performance.now() - this.segmentStartedAt
      this.requestApp(this.config.perfPath, {
        perf: { id: randomUUID(), partialToFinalMs, textLength: caption.text.length },
      })
    }
    this.segmentStartedAt = undefined
    if (!this.stopped) this.postStatus("connected")
  }

  private postStatus(status: Exclude<LivestreamSessionStatus, "idle">, error?: string) {
    this.status = status
    this.requestApp(this.config.statusPath, { error, status })
  }

  private requestApp(path: string, payload?: object) {
    this.appRequests = this.appRequests.then(async () => {
      if (this.consecutiveAppFailures >= MAX_CONSECUTIVE_APP_FAILURES) return

      try {
        const result = await fetch(new URL(path, this.config.appBaseUrl), {
          method: payload ? "POST" : "GET",
          headers: {
            "Content-Type": "application/json",
            "x-salomon-ingest-token": this.config.ingestToken,
          },
          body: payload && JSON.stringify(payload),
          signal: AbortSignal.timeout(5_000),
        })
        if (result.status === 401 || result.status === 404) {
          this.consecutiveAppFailures = MAX_CONSECUTIVE_APP_FAILURES - 1
        }
        if (!result.ok) throw new Error(`App returned HTTP ${result.status}.`)

        const { currentStatus: status } = await result.json() as StatusRoutePayload
        this.consecutiveAppFailures = 0
        if (!status || this.stopped) return

        const wasPaused = this.paused
        this.paused = status === "paused"
        if (!wasPaused && this.paused) {
          this.segmentStartedAt = undefined
          await this.finishStream()
        }
      } catch (error) {
        this.consecutiveAppFailures += 1
        if (!this.stopped && this.consecutiveAppFailures === MAX_CONSECUTIVE_APP_FAILURES) {
          console.warn(`[Media Soniox] App requests failed for ${this.config.sessionId}:`, error)
          void this.config.onStopFromControlPlane(this).catch((stopError: unknown) => {
            console.error(`[Media Soniox] Could not stop ${this.config.sessionId}:`, stopError)
          })
        }
      }
    })
    return this.appRequests
  }
}
