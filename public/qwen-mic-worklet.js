class QwenMicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const targetSampleRate =
      options?.processorOptions?.targetSampleRate ?? 16000

    this.targetSampleRate = targetSampleRate
    this.ratio = sampleRate / this.targetSampleRate
    this.pendingSamples = new Float32Array(0)
    this.resampleOffset = 0
  }

  appendSamples(input) {
    const merged = new Float32Array(this.pendingSamples.length + input.length)
    merged.set(this.pendingSamples, 0)
    merged.set(input, this.pendingSamples.length)
    this.pendingSamples = merged
  }

  emitPcmFrames() {
    if (this.pendingSamples.length < 2) {
      return
    }

    const maxIndex = this.pendingSamples.length - 1
    const outputLength = Math.floor((maxIndex - this.resampleOffset) / this.ratio)

    if (outputLength <= 0) {
      return
    }

    const pcmFrames = new Int16Array(outputLength)

    for (let index = 0; index < outputLength; index++) {
      const sourceIndex = this.resampleOffset + index * this.ratio
      const floorIndex = Math.floor(sourceIndex)
      const ceilIndex = Math.min(floorIndex + 1, maxIndex)
      const interpolation = sourceIndex - floorIndex
      const sample =
        this.pendingSamples[floorIndex] * (1 - interpolation) +
        this.pendingSamples[ceilIndex] * interpolation
      const clamped = Math.max(-1, Math.min(1, sample))
      pcmFrames[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    }

    const consumed = Math.floor(this.resampleOffset + outputLength * this.ratio)
    this.resampleOffset = this.resampleOffset + outputLength * this.ratio - consumed
    this.pendingSamples = this.pendingSamples.slice(consumed)

    this.port.postMessage(pcmFrames.buffer, [pcmFrames.buffer])
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel || channel.length === 0) {
      return true
    }

    this.appendSamples(channel)
    this.emitPcmFrames()
    return true
  }
}

registerProcessor("qwen-mic-capture", QwenMicCaptureProcessor)
