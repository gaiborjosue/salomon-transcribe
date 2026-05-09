import { randomUUID } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

import {
  getLocalWorkerPythonPath,
  getWorkerScriptPath,
} from "@/lib/server-worker-paths"

const PCM_SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const SILERO_FRAME_SAMPLES = 512
const VAD_WORKER_TIMEOUT_MS = 15_000

interface VadEvent {
  sample: number
  type: "end" | "start"
}

interface VadAnalyzeResult {
  currentSample: number
  events: VadEvent[]
  triggered: boolean
}

interface PendingWorkerRequest<T> {
  reject: (error: Error) => void
  resolve: (value: T) => void
}

interface SileroVadConfig {
  minSilenceDurationMs: number
  speechPadMs: number
  threshold: number
}

interface ServerSpeechSegmenterConfig {
  maxSegmentMs: number
  minSegmentMs: number
  overlapMs: number
  vad: SileroVadConfig
}

function toByteOffset(sampleOffset: number) {
  return Math.max(0, sampleOffset) * BYTES_PER_SAMPLE
}

class SileroVadWorkerClient {
  private worker: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<string, PendingWorkerRequest<unknown>>()
  private workerReadyPromise: Promise<void> | null = null
  private workerReadyResolve: (() => void) | null = null
  private stdoutBuffer = ""

  private async ensureWorker() {
    if (this.worker && this.workerReadyPromise) {
      await this.workerReadyPromise
      return
    }

    const projectRoot = process.cwd()
    const pythonPath = getLocalWorkerPythonPath(projectRoot)
    const scriptPath = getWorkerScriptPath(projectRoot, "silero_vad_worker.py")

    this.workerReadyPromise = new Promise<void>((resolve) => {
      this.workerReadyResolve = resolve
    })

    this.worker = spawn(pythonPath, [scriptPath], {
      cwd: projectRoot,
      stdio: "pipe",
    })

    this.worker.stdout.setEncoding("utf8")
    this.worker.stdout.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk
      const lines = this.stdoutBuffer.split("\n")
      this.stdoutBuffer = lines.pop() || ""

      for (const line of lines) {
        if (!line.trim()) continue

        try {
          const message = JSON.parse(line) as
            | { type: "ready" }
            | { error?: string; id?: string; ok?: boolean; result?: unknown }

          if ("type" in message && message.type === "ready") {
            this.workerReadyResolve?.()
            this.workerReadyResolve = null
            continue
          }

          const response = message as {
            error?: string
            id?: string
            ok?: boolean
            result?: unknown
          }

          const messageId = typeof response.id === "string" ? response.id : ""
          if (!messageId) continue

          const pending = this.pending.get(messageId)
          if (!pending) continue

          this.pending.delete(messageId)

          if (!response.ok) {
            pending.reject(
              new Error(response.error || "Silero VAD worker returned an invalid response.")
            )
            continue
          }

          pending.resolve(response.result)
        } catch {
          // Let the request timeout/fallback path deal with malformed worker output.
        }
      }
    })

    this.worker.stderr.setEncoding("utf8")
    this.worker.stderr.on("data", () => {
      // Worker stderr is intentionally ignored in-app.
    })

    this.worker.on("error", (error) => {
      this.worker = null
      this.workerReadyPromise = null
      this.workerReadyResolve = null
      for (const [, pending] of this.pending) {
        pending.reject(error)
      }
      this.pending.clear()
    })

    this.worker.on("close", () => {
      this.worker = null
      this.workerReadyPromise = null
      this.workerReadyResolve = null
      for (const [, pending] of this.pending) {
        pending.reject(new Error("Silero VAD worker closed unexpectedly."))
      }
      this.pending.clear()
    })

    await this.workerReadyPromise
  }

  private async sendRequest<T>(payload: Record<string, unknown>) {
    await this.ensureWorker()

    if (!this.worker) {
      throw new Error("Silero VAD worker is not available.")
    }

    const id = randomUUID()

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("Silero VAD worker timed out."))
      }, VAD_WORKER_TIMEOUT_MS)

      this.pending.set(id, {
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value as T)
        },
      })

      this.worker?.stdin.write(
        `${JSON.stringify({ ...payload, id })}\n`,
        "utf8",
        (error) => {
          if (!error) {
            return
          }

          const pending = this.pending.get(id)
          if (!pending) {
            return
          }

          this.pending.delete(id)
          clearTimeout(timeout)
          pending.reject(error)
        }
      )
    })
  }

  analyzeChunk(sessionId: string, audioBuffer: Buffer, config: SileroVadConfig) {
    return this.sendRequest<VadAnalyzeResult>({
      audio: audioBuffer.toString("base64"),
      config,
      op: "analyze",
      sampleRate: PCM_SAMPLE_RATE,
      sessionId,
    })
  }

  resetSession(sessionId: string) {
    return this.sendRequest<{ reset: true }>({
      op: "reset",
      sessionId,
    })
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __sileroVadWorkerClient__: SileroVadWorkerClient | undefined
}

const sileroVadWorkerClient =
  globalThis.__sileroVadWorkerClient__ ?? new SileroVadWorkerClient()

if (!globalThis.__sileroVadWorkerClient__) {
  globalThis.__sileroVadWorkerClient__ = sileroVadWorkerClient
}

export function getServerSpeechSegmenterConfig(
  mode: "conversation" | "sermon"
): ServerSpeechSegmenterConfig {
  if (mode === "sermon") {
    return {
      maxSegmentMs: 22_000,
      minSegmentMs: 1_400,
      overlapMs: 700,
      vad: {
        minSilenceDurationMs: 950,
        speechPadMs: 500,
        threshold: 0.5,
      },
    }
  }

  return {
    maxSegmentMs: 12_000,
    minSegmentMs: 850,
    overlapMs: 350,
    vad: {
      minSilenceDurationMs: 650,
      speechPadMs: 500,
      threshold: 0.5,
    },
  }
}

export class ServerSpeechSegmenter {
  private activeSegmentStartSample: number | null = null
  private buffer = Buffer.alloc(0)
  private bufferStartSample = 0
  private pending = Promise.resolve<Buffer[]>([])
  private receivedSamples = 0

  private readonly keepTailSamples = Math.max(
    SILERO_FRAME_SAMPLES * 2,
    Math.round(
      ((this.config.vad.speechPadMs + this.config.vad.minSilenceDurationMs) / 1000) *
        PCM_SAMPLE_RATE
    )
  )
  private readonly maxSegmentSamples = Math.round(
    (this.config.maxSegmentMs / 1000) * PCM_SAMPLE_RATE
  )
  private readonly minSegmentSamples = Math.round(
    (this.config.minSegmentMs / 1000) * PCM_SAMPLE_RATE
  )
  private readonly overlapSamples = Math.round(
    (this.config.overlapMs / 1000) * PCM_SAMPLE_RATE
  )

  constructor(
    private readonly sessionId: string,
    private readonly config: ServerSpeechSegmenterConfig
  ) {}

  pushPcm(audioChunk: Buffer): Promise<Buffer[]> {
    const next = this.pending.then(() => this.processChunk(audioChunk))
    this.pending = next.then(() => [], () => [])
    return next
  }

  async flush() {
    await this.pending
    const segments: Buffer[] = []

    if (this.activeSegmentStartSample !== null) {
      const segment = this.finalizeSegment(
        this.activeSegmentStartSample,
        this.receivedSamples,
        false
      )
      this.activeSegmentStartSample = null
      if (segment) {
        segments.push(segment)
      }
    }

    this.trimBuffer()
    return segments
  }

  async reset() {
    await this.pending
    this.activeSegmentStartSample = null
    this.buffer = Buffer.alloc(0)
    this.bufferStartSample = 0
    this.receivedSamples = 0
    await sileroVadWorkerClient.resetSession(this.sessionId).catch(() => {
      // Best-effort reset.
    })
  }

  private async processChunk(audioChunk: Buffer) {
    if (audioChunk.length === 0) {
      return []
    }

    const nextSegments: Buffer[] = []
    this.buffer = Buffer.concat([this.buffer, audioChunk])
    this.receivedSamples += Math.floor(audioChunk.length / BYTES_PER_SAMPLE)

    const analysis = await sileroVadWorkerClient.analyzeChunk(
      this.sessionId,
      audioChunk,
      this.config.vad
    )

    for (const event of analysis.events) {
      if (event.type === "start") {
        if (this.activeSegmentStartSample === null) {
          this.activeSegmentStartSample = event.sample
        }
        continue
      }

      if (this.activeSegmentStartSample === null) {
        continue
      }

      const segment = this.finalizeSegment(
        this.activeSegmentStartSample,
        event.sample,
        false
      )
      this.activeSegmentStartSample = null
      if (segment) {
        nextSegments.push(segment)
      }
    }

    while (
      this.activeSegmentStartSample !== null &&
      this.receivedSamples - this.activeSegmentStartSample >= this.maxSegmentSamples
    ) {
      const flushEndSample = this.activeSegmentStartSample + this.maxSegmentSamples
      const segment = this.finalizeSegment(
        this.activeSegmentStartSample,
        flushEndSample,
        true
      )
      this.activeSegmentStartSample = Math.max(
        this.bufferStartSample,
        flushEndSample - this.overlapSamples
      )
      if (segment) {
        nextSegments.push(segment)
      }
    }

    this.trimBuffer()
    return nextSegments
  }

  private finalizeSegment(
    startSample: number,
    endSample: number,
    forced: boolean
  ): Buffer | null {
    const clampedStart = Math.max(this.bufferStartSample, startSample)
    const clampedEnd = Math.min(this.receivedSamples, Math.max(clampedStart, endSample))
    const sampleLength = clampedEnd - clampedStart

    if (!forced && sampleLength < this.minSegmentSamples) {
      return null
    }

    const startOffset = toByteOffset(clampedStart - this.bufferStartSample)
    const endOffset = toByteOffset(clampedEnd - this.bufferStartSample)
    if (endOffset <= startOffset) {
      return null
    }

    return Buffer.from(this.buffer.subarray(startOffset, endOffset))
  }

  private trimBuffer() {
    const keepFromSample =
      this.activeSegmentStartSample !== null
        ? Math.max(this.bufferStartSample, this.activeSegmentStartSample)
        : Math.max(0, this.receivedSamples - this.keepTailSamples)

    if (keepFromSample <= this.bufferStartSample) {
      return
    }

    const dropBytes = toByteOffset(keepFromSample - this.bufferStartSample)
    this.buffer = Buffer.from(this.buffer.subarray(dropBytes))
    this.bufferStartSample = keepFromSample
  }
}
