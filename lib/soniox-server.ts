import { RealtimeError, SonioxNodeClient } from "@soniox/node"

import {
  SONIOX_TRANSLATION_CONFIG,
  SonioxTranslationBuffer,
} from "@/lib/soniox-translation"

import type { TranscriptCaption } from "@/lib/transcript-types"

export const SONIOX_SAMPLE_RATE = 16_000
const AUDIO_FRAME_BYTES = SONIOX_SAMPLE_RATE * 2 / 10

export function createSonioxClient() {
  const apiKey = process.env.SONIOX_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("SONIOX_API_KEY is not configured.")
  }
  return new SonioxNodeClient({ api_key: apiKey })
}

export function isPermanentSonioxError(error: Error) {
  return error instanceof RealtimeError && [400, 401, 402, 403].includes(error.statusCode ?? 0)
}

export class SonioxAudioStream {
  private readonly session
  private frameRemainder = Buffer.alloc(0)
  private keepAlive: ReturnType<typeof setInterval> | undefined
  private finishPromise: Promise<void> | undefined

  constructor({
    onError,
    onFinal,
    onPartial,
  }: {
    onError: (error: Error) => void
    onFinal: (caption: TranscriptCaption) => void
    onPartial?: (captions: TranscriptCaption[]) => void
  }) {
    this.session = createSonioxClient().realtime.stt({
      ...SONIOX_TRANSLATION_CONFIG,
      audio_format: "pcm_s16le",
      sample_rate: SONIOX_SAMPLE_RATE,
      num_channels: 1,
    })
    const translation = new SonioxTranslationBuffer()
    const flushTranslation = () => {
      for (const caption of translation.takeFinal()) onFinal(caption)
      onPartial?.([])
    }

    this.session
      .on("result", (result) => {
        const preview = translation.update(result)
        if (result.tokens.length) onPartial?.(preview)
      })
      .on("endpoint", flushTranslation)
      .on("finished", () => {
        clearInterval(this.keepAlive)
        flushTranslation()
      })
      .on("error", (error) => {
        clearInterval(this.keepAlive)
        flushTranslation()
        if (!this.finishPromise) onError(error)
      })
  }

  async connect() {
    await this.session.connect()
    if (this.session.state === "connected") {
      this.keepAlive = setInterval(() => this.session.keepAlive(), 5_000)
    }
  }

  send(chunk: Buffer) {
    if (this.session.state !== "connected" || this.finishPromise) return

    const audio = this.frameRemainder.length
      ? Buffer.concat([this.frameRemainder, chunk])
      : chunk
    let offset = 0
    for (; offset + AUDIO_FRAME_BYTES <= audio.length; offset += AUDIO_FRAME_BYTES) {
      this.session.sendAudio(audio.subarray(offset, offset + AUDIO_FRAME_BYTES))
    }
    this.frameRemainder = Buffer.from(audio.subarray(offset))
  }

  finish() {
    this.finishPromise ??= this.finishSession()
    return this.finishPromise
  }

  private async finishSession() {
    clearInterval(this.keepAlive)
    if (this.session.state !== "connected") {
      this.session.close()
      return
    }

    const audio = this.frameRemainder.subarray(0, this.frameRemainder.length & ~1)
    if (audio.length) this.session.sendAudio(audio)

    const timeout = setTimeout(() => this.session.close(), 5_000)
    try {
      await this.session.finish()
    } finally {
      clearTimeout(timeout)
    }
  }
}
