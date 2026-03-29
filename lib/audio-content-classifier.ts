import { randomUUID } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"

export interface AudioContentClassification {
  decision: "mixed" | "music" | "speech"
  musicScore: number
  speechScore: number
  topLabel: string
  topScore: number
}

export function shouldSkipForMusic(
  classification: AudioContentClassification
): boolean {
  return (
    classification.decision === "music" &&
    classification.musicScore >= 0.32 &&
    classification.speechScore <= 0.12
  )
}

export function extractPcm16MonoFromWav(wavBuffer: Buffer): {
  data: Buffer
  sampleRate: number
} | null {
  if (wavBuffer.length < 44) {
    return null
  }

  if (wavBuffer.toString("ascii", 0, 4) !== "RIFF") {
    return null
  }

  if (wavBuffer.toString("ascii", 8, 12) !== "WAVE") {
    return null
  }

  let offset = 12
  let sampleRate = 16000
  let channels = 1
  let bitsPerSample = 16
  let dataChunk: Buffer | null = null

  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString("ascii", offset, offset + 4)
    const chunkSize = wavBuffer.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkSize

    if (chunkEnd > wavBuffer.length) {
      break
    }

    if (chunkId === "fmt ") {
      channels = wavBuffer.readUInt16LE(chunkStart + 2)
      sampleRate = wavBuffer.readUInt32LE(chunkStart + 4)
      bitsPerSample = wavBuffer.readUInt16LE(chunkStart + 14)
    }

    if (chunkId === "data") {
      dataChunk = wavBuffer.subarray(chunkStart, chunkEnd)
      break
    }

    offset = chunkEnd + (chunkSize % 2)
  }

  if (!dataChunk || channels !== 1 || bitsPerSample !== 16) {
    return null
  }

  return {
    data: dataChunk,
    sampleRate,
  }
}

interface PendingRequest {
  reject: (error: Error) => void
  resolve: (value: AudioContentClassification) => void
}

class AudioContentClassifier {
  private worker: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private workerReadyPromise: Promise<void> | null = null
  private workerReadyResolve: (() => void) | null = null
  private stdoutBuffer = ""

  private async ensureWorker() {
    if (this.worker && this.workerReadyPromise) {
      await this.workerReadyPromise
      return
    }

    const projectRoot = process.cwd()
    const pythonPath = path.join(projectRoot, ".venv-yamnet", "bin", "python")
    const scriptPath = path.join(projectRoot, "scripts", "yamnet_worker.py")

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
            | {
                error?: string
                id?: string
                ok?: boolean
                result?: AudioContentClassification
              }

          if ("type" in message && message.type === "ready") {
            this.workerReadyResolve?.()
            this.workerReadyResolve = null
            continue
          }

          const response = message as {
            error?: string
            id?: string
            ok?: boolean
            result?: AudioContentClassification
          }

          const messageId = typeof response.id === "string" ? response.id : ""
          if (!messageId) continue

          const pending = this.pending.get(messageId)
          if (!pending) continue

          this.pending.delete(messageId)

          if (!response.ok || !response.result) {
            pending.reject(
              new Error(response.error || "YAMNet worker returned an invalid response.")
            )
            continue
          }

          pending.resolve(response.result)
        } catch {
          // Ignore malformed worker output and allow request timeout/fallback logic upstream.
        }
      }
    })

    this.worker.stderr.setEncoding("utf8")
    this.worker.stderr.on("data", () => {
      // stderr is intentionally ignored in-app; classifier failures fall back gracefully.
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
        pending.reject(new Error("YAMNet worker closed unexpectedly."))
      }
      this.pending.clear()
    })

    await this.workerReadyPromise
  }

  async classifyPcm16(audioBuffer: Buffer, sampleRate: number) {
    await this.ensureWorker()

    if (!this.worker) {
      throw new Error("YAMNet worker is not available.")
    }

    const id = randomUUID()
    const payload = {
      audio: audioBuffer.toString("base64"),
      id,
      sampleRate,
    }

    return await new Promise<AudioContentClassification>((resolve, reject) => {
      this.pending.set(id, { reject, resolve })
      this.worker?.stdin.write(`${JSON.stringify(payload)}\n`, "utf8")
    })
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __audioContentClassifier__: AudioContentClassifier | undefined
}

export const audioContentClassifier =
  globalThis.__audioContentClassifier__ ?? new AudioContentClassifier()

if (!globalThis.__audioContentClassifier__) {
  globalThis.__audioContentClassifier__ = audioContentClassifier
}
